import type { Fuel, Slot, Truck } from "./types";

export const STORAGE_KEYS = {
  /** 主台账 */
  ledger: "hxwlfront-19-dispatch-ledger-v1",
  /** 写写前记录（WAL），与主台账成对出现 */
  pending: "hxwlfront-19-dispatch-pending-v1",
  /** 派车草稿（按配送单保存，冲突 / 中断都不丢） */
  drafts: "hxwlfront-19-dispatch-drafts-v1",
  /** 建单表单草稿 */
  createDraft: "hxwlfront-19-dispatch-create-draft-v1",
  /** 旧版整单表，迁移只读不改 */
  legacy: "hxwlfront-19-oil-delivery"
} as const;

export const STATIONS = ["城东站", "机场站", "新区站"] as const;

export const FUELS: Fuel[] = [{ name: "92号汽油" }, { name: "95号汽油" }, { name: "柴油" }];

/** 计划到达时段：按半天窗口聚合车辆与罐容 */
export const SLOTS: Slot[] = [
  { id: "morning", label: "上午 08:00–12:00", startHour: 8, endHour: 12 },
  { id: "afternoon", label: "下午 13:00–17:00", startHour: 13, endHour: 17 }
];

export const TRUCKS: Truck[] = [
  { id: "truck-A", name: "油罐车 A（30t）", capacity: 30, fuels: ["92号汽油", "95号汽油"] },
  { id: "truck-B", name: "油罐车 B（25t）", capacity: 25, fuels: ["柴油"] },
  { id: "truck-C", name: "油罐车 C（20t）", capacity: 20, fuels: ["92号汽油", "95号汽油", "柴油"] }
];

export const ORDER_STATUSES = [
  "待派车",
  "已预占",
  "装车中",
  "运输中",
  "已到站",
  "撤单",
  "在途失败"
] as const;

/** 汇总图表按这五类展示，撤单 / 在途失败单独列出 */
export const CHART_STATUSES = [
  "待派车",
  "已预占",
  "装车中",
  "运输中",
  "已到站",
  "撤单",
  "在途失败"
] as const;

export function todayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function getSlot(slotId: string): Slot {
  return SLOTS.find((slot) => slot.id === slotId) ?? SLOTS[0];
}

/** 计算某配送单的计划到达窗口 [start, end) */
export function arrivalWindow(arriveDate: string, slotId: string): { start: string; end: string } {
  const slot = getSlot(slotId);
  const start = new Date(`${arriveDate}T00:00:00`);
  start.setHours(slot.startHour, 0, 0, 0);
  const end = new Date(`${arriveDate}T00:00:00`);
  end.setHours(slot.endHour, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** 两个左闭右开窗口是否重叠 */
export function windowsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  const as = Date.parse(aStart);
  const ae = Date.parse(aEnd);
  const bs = Date.parse(bStart);
  const be = Date.parse(bEnd);
  return as < be && bs < ae;
}
