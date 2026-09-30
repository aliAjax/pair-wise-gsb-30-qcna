import { arrivalWindow, windowsOverlap } from "./domain";
import type { DispatchConflict, DispatchLedger, Occupancy, Order } from "./types";

/** 仍占着车辆 / 罐容的明细（已释放的不参与计算） */
export function activeOccupancies(ledger: DispatchLedger): Occupancy[] {
  return ledger.occupancies.filter((item) => item.status !== "已释放");
}

/** 与给定到达窗口重叠、且属于同一车辆的有效占用明细（可排除指定单据，供改派场景） */
export function overlappingOccupancies(
  ledger: DispatchLedger,
  truckId: string,
  arriveDate: string,
  slotId: string,
  excludeOrderId?: string
): Occupancy[] {
  const { start, end } = arrivalWindow(arriveDate, slotId);
  return activeOccupancies(ledger).filter(
    (item) =>
      item.truckId === truckId &&
      item.id !== excludeOrderId &&
      (!excludeOrderId || item.orderId !== excludeOrderId) &&
      windowsOverlap(item.windowStart, item.windowEnd, start, end)
  );
}

/**
 * 派车前校验：
 * - STAGE        单据当前状态不允许派车
 * - OVER_LIMIT   配送吨数超过该油罐车罐容（一车装不下）
 * - OVERLOAD     同一到达时段内聚合预占 + 本次需求，超过罐容（撞车 / 超量）
 * - FUEL_MISMATCH 该车不允许承运该油品
 * - FUEL_MIX     同一时段该车已安排其它油品，不能混装
 */
export function checkDispatch(
  ledger: DispatchLedger,
  order: Order,
  truckId: string,
  tons: number,
  arriveDate: string,
  slotId: string
): DispatchConflict[] {
  const conflicts: DispatchConflict[] = [];
  if (order.status !== "待派车") {
    conflicts.push({
      code: "STAGE",
      message: `单据当前为「${order.status}」，只有「待派车」的配送单可以派车。`
    });
    return conflicts;
  }

  const truck = ledger.trucks.find((item) => item.id === truckId);
  if (!truck) {
    conflicts.push({ code: "FUEL_MISMATCH", message: "请选择油罐车。" });
    return conflicts;
  }

  if (!truck.fuels.includes(order.fuel)) {
    conflicts.push({
      code: "FUEL_MISMATCH",
      message: `${truck.name} 不允许承运「${order.fuel}」，只能装载 ${truck.fuels.join("、")}。`
    });
  }

  if (tons > truck.capacity) {
    conflicts.push({
      code: "OVER_LIMIT",
      message: `本次需装 ${tons} 吨，超过 ${truck.name} ${truck.capacity} 吨罐容，单车装不下，请换更大的车。`
    });
  }

  const others = overlappingOccupancies(ledger, truckId, arriveDate, slotId, order.id);
  const used = others.reduce((sum, item) => sum + item.tons, 0);
  const remaining = truck.capacity - used;
  if (used + tons > truck.capacity) {
    const orderIds = [...new Set(others.map((item) => item.orderId))];
    conflicts.push({
      code: "OVERLOAD",
      otherOrderId: orderIds[0],
      message: `${truck.name} 在该计划到达时段已被预占 ${used} 吨，剩 ${remaining} 吨容量；本次再排 ${tons} 吨将超量（撞车），请改时段或换车。`
    });
  }

  const mixed = others.find((item) => item.fuel !== order.fuel);
  if (mixed) {
    conflicts.push({
      code: "FUEL_MIX",
      otherOrderId: mixed.orderId,
      message: `${truck.name} 在同一时段已安排「${mixed.fuel}」（单据 ${mixed.orderId.slice(0, 8)}），不能与「${order.fuel}」混装。`
    });
  }

  return conflicts;
}

/** 车辆在某到达时段的实时占用：预占 + 占用一起计入 */
export function truckWindowUsage(
  ledger: DispatchLedger,
  truckId: string,
  arriveDate: string,
  slotId: string
): { used: number; reserved: number; occupied: number; items: Occupancy[] } {
  const items = overlappingOccupancies(ledger, truckId, arriveDate, slotId);
  const reserved = items.filter((item) => item.status === "预占").reduce((s, i) => s + i.tons, 0);
  const occupied = items.filter((item) => item.status === "占用").reduce((s, i) => s + i.tons, 0);
  return { used: reserved + occupied, reserved, occupied, items };
}

export function findOrder(ledger: DispatchLedger, orderId: string): Order | undefined {
  return ledger.orders.find((item) => item.id === orderId);
}

export function orderActiveOccupancies(ledger: DispatchLedger, orderId: string): Occupancy[] {
  return activeOccupancies(ledger).filter((item) => item.orderId === orderId);
}
