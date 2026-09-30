import {
  PHASE_WINDOWS,
  type Assignment,
  type AssignmentPhase,
  type Conflict,
  type DayPhase,
  type DeliveryOrder,
  type Ledger,
  type Operation,
  type OrderStatus,
  type Truck
} from "./types";

export function uid(prefix = "id"): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function toDateString(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function todayString(): string {
  return toDateString(new Date());
}

/** 计算计划到达时段；night 跨零点时结束时间落在次日 00:00 */
export function arrivalWindow(date: string, phase: DayPhase): { start: string; end: string } {
  const win = PHASE_WINDOWS[phase];
  const start = `${date}T${pad2(win.startHour)}:00`;
  if (win.endHour === 24) {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + 1);
    return { start, end: `${toDateString(d)}T00:00` };
  }
  return { start, end: `${date}T${pad2(win.endHour)}:00` };
}

export function formatWindow(assignment: Pick<Assignment, "windowStart" | "windowEnd">): string {
  const start = assignment.windowStart.replace("T", " ");
  const end = assignment.windowEnd.slice(11, 16);
  return `${start}–${end}`;
}

/** 两个半开时段是否重叠（首尾相接不算撞车） */
export function windowsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** 仍在占用车辆/罐容的排车：草稿与已释放/已完成都不计 */
export function isLive(assignment: Assignment): boolean {
  return assignment.phase === "reserved" || assignment.phase === "occupied";
}

export function truckById(ledger: Ledger, truckId: string): Truck | undefined {
  return ledger.trucks.find((truck) => truck.id === truckId);
}

export function orderById(ledger: Ledger, orderId: string): DeliveryOrder | undefined {
  return ledger.orders.find((order) => order.id === orderId);
}

export function liveAssignments(ledger: Ledger, truckId?: string): Assignment[] {
  return ledger.assignments.filter((a) => isLive(a) && (truckId === undefined || a.truckId === truckId));
}

/** 某车在某时段已被预占/占用的罐容（吨） */
export function occupiedTons(ledger: Ledger, truckId: string, start: string, end: string): number {
  return liveAssignments(ledger, truckId)
    .filter((a) => windowsOverlap(start, end, a.windowStart, a.windowEnd))
    .reduce((sum, a) => sum + a.tons, 0);
}

/** 该车是否还有其它在途（已占用）排车 —— 决定车辆能否回到"可用" */
export function truckHasOtherOccupied(ledger: Ledger, truckId: string, excludeAssignmentId?: string): boolean {
  return ledger.assignments.some(
    (a) => a.truckId === truckId && a.phase === "occupied" && a.id !== excludeAssignmentId
  );
}

/**
 * 派车校验：车辆状态、油品适配、单车单送、罐容（含同时段叠加）、时段撞车。
 * excludeAssignmentId 用于重试覆盖时排除自身。
 */
export function evaluateDispatch(
  ledger: Ledger,
  draft: { orderId: string; truckId: string; tons: number; windowStart: string; windowEnd: string },
  excludeAssignmentId?: string
): Conflict[] {
  const conflicts: Conflict[] = [];
  const truck = truckById(ledger, draft.truckId);
  const order = orderById(ledger, draft.orderId);
  if (!truck) {
    conflicts.push({ code: "truck-missing", message: "所选油罐车不存在，请刷新调度台后重试" });
    return conflicts;
  }
  if (!order) {
    conflicts.push({ code: "order-missing", message: "配送单不存在或已被删除" });
    return conflicts;
  }
  if (draft.tons <= 0) {
    conflicts.push({ code: "tons-invalid", message: "配送吨数必须大于 0" });
  }
  // 该单已有其它生效排车（非本次重试覆盖对象）→ 防止并发提交互相盖掉
  const existing = liveAssignments(ledger).find(
    (a) => a.orderId === draft.orderId && a.id !== excludeAssignmentId
  );
  if (existing) {
    const existingTruck = truckById(ledger, existing.truckId);
    conflicts.push({
      code: "already-assigned",
      message: `该配送单已有生效排车（${existingTruck?.name ?? "其它车辆"} · ${existing.phase === "occupied" ? "已占用" : "已预占"}），请先释放后再改派`
    });
  }
  if (truck.status === "检修") {
    conflicts.push({ code: "truck-repair", message: `${truck.name}（${truck.plate}）正在检修，暂不可派` });
  }
  if (!truck.fuels.includes(order.fuel)) {
    conflicts.push({
      code: "fuel-unsupported",
      message: `${truck.name} 不具备 ${order.fuel} 运输资质（可装：${truck.fuels.join("、") || "无"}）`
    });
  }
  if (draft.tons > truck.capacity) {
    conflicts.push({
      code: "capacity-over",
      message: `超罐容：${truck.name} 核定 ${truck.capacity} 吨，本单 ${draft.tons} 吨，超出 ${draft.tons - truck.capacity} 吨`
    });
  }
  // 同一时段与其它活跃排车撞车（同一张单重试的那条由 exclude 排除）
  const clash = liveAssignments(ledger, truck.id).find(
    (a) =>
      a.id !== excludeAssignmentId &&
      windowsOverlap(draft.windowStart, draft.windowEnd, a.windowStart, a.windowEnd)
  );
  if (clash) {
    const other = orderById(ledger, clash.orderId);
    const sameFuel = clash.fuel === order.fuel;
    if (!sameFuel) {
      conflicts.push({
        code: "fuel-mix",
        message: `油品混装冲突：${truck.name} 该时段已排 ${other?.station ?? clash.orderId} 的 ${clash.fuel}（${clash.tons} 吨），不能再装 ${order.fuel}`
      });
    }
    if (clash.tons + draft.tons > truck.capacity) {
      conflicts.push({
        code: "window-over",
        message: `时段罐容超限：${truck.name} 同时段已排 ${clash.tons} 吨，再加 ${draft.tons} 吨将超过核定 ${truck.capacity} 吨`
      });
    }
    conflicts.push({
      code: "truck-busy",
      message: `时段撞车：${truck.name} 在 ${formatWindow({ windowStart: clash.windowStart, windowEnd: clash.windowEnd })} 已安排给 ${other?.station ?? "其它配送单"}`
    });
  }
  return conflicts;
}

export function createEmptyLedger(seededAt: string): Ledger {
  return { version: 1, schema: 2, trucks: [], orders: [], assignments: [], meta: { seededAt } };
}

function upsertOrder(ledger: Ledger, order: DeliveryOrder) {
  const index = ledger.orders.findIndex((o) => o.id === order.id);
  if (index >= 0) ledger.orders[index] = order;
  else ledger.orders.unshift(order);
}

function setOrderStatus(ledger: Ledger, orderId: string, status: OrderStatus) {
  const order = orderById(ledger, orderId);
  if (order) order.status = status;
}

function upsertAssignment(ledger: Ledger, assignment: Assignment) {
  const index = ledger.assignments.findIndex((a) => a.id === assignment.id);
  if (index >= 0) ledger.assignments[index] = assignment;
  else ledger.assignments.push(assignment);
}

function setAssignmentPhase(ledger: Ledger, assignmentId: string, phase: AssignmentPhase, at: string) {
  const assignment = ledger.assignments.find((a) => a.id === assignmentId);
  if (assignment) {
    assignment.phase = phase;
    assignment.updatedAt = at;
    if (phase !== "draft") delete assignment.conflictCodes;
  }
}

/** 找到配送单当前有效的排车（含草稿），用于装车确认/撤单释放 */
export function activeAssignmentOf(ledger: Ledger, orderId: string): Assignment | undefined {
  return ledger.assignments
    .filter((a) => a.orderId === orderId && a.phase !== "released" && a.phase !== "completed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/**
 * 纯函数：在台账上应用一条操作。所有动作幂等（按 op.id 去重由存储层负责），
 * 同一操作重放结果一致，这是写入中断后可恢复的基础。
 */
export function applyOp(ledger: Ledger, op: Operation): Ledger {
  const next: Ledger = {
    ...ledger,
    trucks: ledger.trucks.map((t) => ({ ...t, fuels: [...t.fuels] })),
    orders: ledger.orders.map((o) => ({ ...o })),
    assignments: ledger.assignments.map((a) => ({ ...a })),
    meta: { ...ledger.meta }
  };
  const p = (op.payload ?? {}) as Record<string, unknown>;

  switch (op.type) {
    case "migrate": {
      const payload = p as { trucks: Truck[]; orders: DeliveryOrder[]; assignments: Assignment[]; migratedAt: string };
      // 旧 id 全部保留，已存在则跳过 —— 迁移只能发生一次
      payload.trucks.forEach((truck) => {
        if (!truckById(next, truck.id)) next.trucks.push({ ...truck });
      });
      payload.orders.forEach((order) => {
        if (!orderById(next, order.id)) upsertOrder(next, { ...order });
      });
      payload.assignments.forEach((assignment) => {
        if (!next.assignments.some((a) => a.id === assignment.id)) {
          next.assignments.push({ ...assignment });
        }
      });
      next.meta.migratedFromV1At = payload.migratedAt;
      next.version += 1;
      break;
    }
    case "seed": {
      const payload = p as { trucks: Truck[]; orders: DeliveryOrder[]; assignments: Assignment[] };
      payload.trucks.forEach((truck) => {
        if (!truckById(next, truck.id)) next.trucks.push({ ...truck });
      });
      payload.orders.forEach((order) => {
        if (!orderById(next, order.id)) upsertOrder(next, { ...order });
      });
      payload.assignments.forEach((assignment) => {
        if (!next.assignments.some((a) => a.id === assignment.id)) {
          next.assignments.push({ ...assignment });
        }
      });
      next.version += 1;
      break;
    }
    case "createOrder": {
      const order = p.order as DeliveryOrder;
      if (!orderById(next, order.id)) {
        upsertOrder(next, { ...order });
        next.version += 1;
      }
      break;
    }
    case "reserve": {
      const payload = p as {
        assignmentId: string;
        orderId: string;
        truckId: string;
        tons: number;
        windowStart: string;
        windowEnd: string;
        conflicts: string[];
      };
      const order = orderById(next, payload.orderId);
      if (!order) break;
      const now = op.at;
      // 重试：复用同一排车 id，保留草稿→预占的完整轨迹
      const previous = next.assignments.find((a) => a.id === payload.assignmentId);
      const assignment: Assignment = {
        id: payload.assignmentId,
        orderId: payload.orderId,
        truckId: payload.truckId,
        tons: payload.tons,
        fuel: order.fuel,
        windowStart: payload.windowStart,
        windowEnd: payload.windowEnd,
        phase: payload.conflicts.length > 0 ? "draft" : "reserved",
        conflictCodes: payload.conflicts.length > 0 ? payload.conflicts : undefined,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      upsertAssignment(next, assignment);
      next.version += 1;
      break;
    }
    case "confirmLoad": {
      const { assignmentId } = p as { assignmentId: string };
      const assignment = next.assignments.find((a) => a.id === assignmentId);
      if (assignment && assignment.phase === "reserved") {
        setAssignmentPhase(next, assignmentId, "occupied", op.at);
        setOrderStatus(next, assignment.orderId, "运输中");
        const truck = truckById(next, assignment.truckId);
        if (truck && truck.status === "可用") truck.status = "在途";
        next.version += 1;
      }
      break;
    }
    case "confirmArrival": {
      const { assignmentId, orderId } = p as { assignmentId?: string; orderId?: string };
      const assignment = assignmentId
        ? next.assignments.find((a) => a.id === assignmentId)
        : activeAssignmentOf(next, orderId ?? "");
      if (assignment && assignment.phase === "occupied") {
        setAssignmentPhase(next, assignment.id, "completed", op.at);
        setOrderStatus(next, assignment.orderId, "已到站");
        const truck = truckById(next, assignment.truckId);
        if (truck && truck.status === "在途" && !truckHasOtherOccupied(next, truck.id, assignment.id)) {
          truck.status = "可用";
        }
        next.version += 1;
      } else if (!assignment && orderId) {
        // 迁移来的"运输中"旧单没有排车记录，到站状态仍可直接流转，不阻断旧流程
        setOrderStatus(next, orderId, "已到站");
        next.version += 1;
      }
      break;
    }
    case "cancelOrder": {
      const { orderId } = p as { orderId: string };
      const assignment = activeAssignmentOf(next, orderId);
      const wasOccupied = assignment?.phase === "occupied";
      if (assignment) {
        setAssignmentPhase(next, assignment.id, "released", op.at);
        const truck = truckById(next, assignment.truckId);
        if (truck && truck.status === "在途" && wasOccupied && !truckHasOtherOccupied(next, truck.id, assignment.id)) {
          truck.status = "可用";
        }
      }
      setOrderStatus(next, orderId, "已撤单");
      next.version += 1;
      break;
    }
    case "failInTransit": {
      const { orderId } = p as { orderId: string };
      const assignment = activeAssignmentOf(next, orderId);
      if (assignment) setAssignmentPhase(next, assignment.id, "released", op.at);
      setOrderStatus(next, orderId, "异常");
      const truckId = assignment?.truckId;
      if (truckId) {
        const truck = truckById(next, truckId);
        if (truck && truck.status === "在途" && !truckHasOtherOccupied(next, truckId, assignment?.id)) {
          truck.status = "可用";
        }
      }
      next.version += 1;
      break;
    }
    case "releaseAssignment": {
      const { assignmentId } = p as { assignmentId: string };
      const target = next.assignments.find((a) => a.id === assignmentId);
      if (target && isLive(target)) {
        const wasOccupied = target.phase === "occupied";
        setAssignmentPhase(next, assignmentId, "released", op.at);
        const truck = truckById(next, target.truckId);
        if (truck && truck.status === "在途" && wasOccupied && !truckHasOtherOccupied(next, truck.id, target.id)) {
          truck.status = "可用";
        }
        next.version += 1;
      }
      break;
    }
    case "deleteOrder": {
      const { orderId } = p as { orderId: string };
      next.orders = next.orders.filter((o) => o.id !== orderId);
      // 排车历史保留（台账留痕），只释放仍有效的占用
      next.assignments.forEach((a) => {
        if (a.orderId === orderId && isLive(a)) setAssignmentPhase(next, a.id, "released", op.at);
      });
      next.version += 1;
      break;
    }
    case "deleteAssignment": {
      const { assignmentId } = p as { assignmentId: string };
      next.assignments = next.assignments.filter((a) => a.id !== assignmentId);
      next.version += 1;
      break;
    }
  }
  return next;
}
