// 调度台领域模型：油罐车、配送单、排车（车辆与罐容占用的载体）

export type FuelType = "92号汽油" | "95号汽油" | "柴油";

/** 计划到达时段（按半天为一个时段） */
export type DayPhase = "morning" | "afternoon" | "night";

export const PHASE_WINDOWS: Record<DayPhase, { label: string; startHour: number; endHour: number }> = {
  morning: { label: "上午", startHour: 8, endHour: 12 },
  afternoon: { label: "下午", startHour: 13, endHour: 18 },
  night: { label: "夜间", startHour: 20, endHour: 24 }
};

export type TruckStatus = "可用" | "在途" | "检修";

export interface Truck {
  id: string;
  name: string;
  plate: string;
  capacity: number; // 核定罐容（吨）
  fuels: FuelType[]; // 允许装载的油品
  status: TruckStatus;
}

/** 配送单状态：待发车 → 运输中 → 已到站；撤单 / 异常（在途失败）为终态 */
export type OrderStatus = "待发车" | "运输中" | "已到站" | "已撤单" | "异常";

export const ORDER_STATUSES: OrderStatus[] = ["待发车", "运输中", "已到站", "已撤单", "异常"];

export interface DeliveryOrder {
  id: string;
  station: string;
  fuel: FuelType;
  tons: number;
  arriveDate: string; // yyyy-mm-dd（本地日期，参与比较的是字符串）
  phase: DayPhase;
  windowStart: string; // yyyy-mm-ddTHH:mm 本地墙上时间
  windowEnd: string;
  notes: string;
  status: OrderStatus;
  createdAt: string;
  /** 旧系统迁移来的原始记录，迁移后不再改动，作为留底 */
  legacy?: Record<string, unknown>;
}

/** 排车阶段：草稿（未占资源）→ 已预占 → 已占用 → 已释放 / 已完成 */
export type AssignmentPhase = "draft" | "reserved" | "occupied" | "released" | "completed";

export const ASSIGNMENT_PHASE_LABEL: Record<AssignmentPhase, string> = {
  draft: "草稿（冲突待处理）",
  reserved: "已预占",
  occupied: "已占用（在途）",
  released: "已释放",
  completed: "已完成"
};

export interface Assignment {
  id: string;
  orderId: string;
  truckId: string;
  tons: number;
  fuel: FuelType;
  windowStart: string;
  windowEnd: string;
  phase: AssignmentPhase;
  conflictCodes?: string[]; // 转草稿时保留的冲突说明
  createdAt: string;
  updatedAt: string;
}

export interface Ledger {
  version: number;
  schema: 2;
  trucks: Truck[];
  orders: DeliveryOrder[];
  assignments: Assignment[];
  meta: {
    seededAt: string;
    migratedFromV1At?: string;
  };
}

export type NoticeLevel = "info" | "success" | "warning" | "error";

export type OpType =
  | "migrate"
  | "seed"
  | "createOrder"
  | "reserve"
  | "confirmLoad"
  | "confirmArrival"
  | "cancelOrder"
  | "failInTransit"
  | "releaseAssignment"
  | "deleteOrder"
  | "deleteAssignment";

/** 每一次状态变更都是一条幂等操作；先写日志再发布台账，写入中断可回放 */
export interface Operation {
  id: string;
  type: OpType;
  at: string;
  payload?: unknown;
}

export interface AppliedRef {
  opId: string;
  type: OpType;
}

export interface Conflict {
  code: string;
  message: string;
}
