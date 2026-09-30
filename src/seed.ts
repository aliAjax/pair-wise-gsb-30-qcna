import type { Assignment, DeliveryOrder, Truck } from "./types";

/** 内置车队（迁移旧数据时也会补入，保证旧单有车可派；固定 id 保证迁移幂等） */
export function buildFleet(): Truck[] {
  return [
    { id: "truck-01", name: "1号油罐车", plate: "京A·H2081", capacity: 25, fuels: ["92号汽油", "95号汽油", "柴油"], status: "可用" },
    { id: "truck-02", name: "2号油罐车", plate: "京A·H3062", capacity: 20, fuels: ["92号汽油", "95号汽油"], status: "在途" },
    { id: "truck-03", name: "3号油罐车", plate: "京A·H5188", capacity: 15, fuels: ["柴油"], status: "可用" }
  ];
}

function shiftDate(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export interface SeedData {
  trucks: Truck[];
  orders: DeliveryOrder[];
  assignments: Assignment[];
}

/** 全新环境的示例台账：覆盖预占、占用、到站、冲突草稿四种现场 */
export function buildSeedData(nowIso: string): SeedData {
  const today = shiftDate(new Date(), 0);
  const yesterday = shiftDate(new Date(), -1);
  const tomorrow = shiftDate(new Date(), 1);
  const trucks = buildFleet();

  const orders: DeliveryOrder[] = [
    {
      id: "seed-order-1",
      station: "城东站",
      fuel: "92号汽油",
      tons: 18,
      arriveDate: today,
      phase: "morning",
      windowStart: `${today}T08:00`,
      windowEnd: `${today}T12:00`,
      notes: "车辆已出库，按计划配送",
      status: "运输中",
      createdAt: nowIso
    },
    {
      id: "seed-order-2",
      station: "机场站",
      fuel: "柴油",
      tons: 12,
      arriveDate: today,
      phase: "morning",
      windowStart: `${today}T08:00`,
      windowEnd: `${today}T12:00`,
      notes: "等待装车",
      status: "待发车",
      createdAt: nowIso
    },
    {
      id: "seed-order-3",
      station: "新区站",
      fuel: "95号汽油",
      tons: 22,
      arriveDate: today,
      phase: "afternoon",
      windowStart: `${today}T13:00`,
      windowEnd: `${today}T18:00`,
      notes: "下午大单，初次派车未通过",
      status: "待发车",
      createdAt: nowIso
    },
    {
      id: "seed-order-4",
      station: "城东站",
      fuel: "柴油",
      tons: 16,
      arriveDate: tomorrow,
      phase: "morning",
      windowStart: `${tomorrow}T08:00`,
      windowEnd: `${tomorrow}T12:00`,
      notes: "暂未排车",
      status: "待发车",
      createdAt: nowIso
    },
    {
      id: "seed-order-5",
      station: "机场站",
      fuel: "92号汽油",
      tons: 14,
      arriveDate: yesterday,
      phase: "morning",
      windowStart: `${yesterday}T08:00`,
      windowEnd: `${yesterday}T12:00`,
      notes: "已完成交接",
      status: "已到站",
      createdAt: nowIso
    }
  ];

  const assignments: Assignment[] = [
    {
      id: "seed-asg-1",
      orderId: "seed-order-1",
      truckId: "truck-02",
      tons: 18,
      fuel: "92号汽油",
      windowStart: `${today}T08:00`,
      windowEnd: `${today}T12:00`,
      phase: "occupied",
      createdAt: nowIso,
      updatedAt: nowIso
    },
    {
      id: "seed-asg-2",
      orderId: "seed-order-2",
      truckId: "truck-03",
      tons: 12,
      fuel: "柴油",
      windowStart: `${today}T08:00`,
      windowEnd: `${today}T12:00`,
      phase: "reserved",
      createdAt: nowIso,
      updatedAt: nowIso
    },
    {
      id: "seed-asg-3",
      orderId: "seed-order-3",
      truckId: "truck-03",
      tons: 22,
      fuel: "95号汽油",
      windowStart: `${today}T13:00`,
      windowEnd: `${today}T18:00`,
      phase: "draft",
      conflictCodes: ["fuel-unsupported", "capacity-over"],
      createdAt: nowIso,
      updatedAt: nowIso
    },
    {
      id: "seed-asg-4",
      orderId: "seed-order-5",
      truckId: "truck-01",
      tons: 14,
      fuel: "92号汽油",
      windowStart: `${yesterday}T08:00`,
      windowEnd: `${yesterday}T12:00`,
      phase: "completed",
      createdAt: nowIso,
      updatedAt: nowIso
    }
  ];

  return { trucks, orders, assignments };
}
