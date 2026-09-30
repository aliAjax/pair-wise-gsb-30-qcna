// 油品配送调度台：领域类型定义

/** 配送单状态 */
export type OrderStatus =
  | "待派车"
  | "已预占"
  | "装车中"
  | "运输中"
  | "已到站"
  | "撤单"
  | "在途失败";

/** 车辆占用明细状态：预占（派车时）→ 占用（装车确认后）→ 已释放 */
export type OccupancyStatus = "预占" | "占用" | "已释放";

export interface Truck {
  id: string;
  name: string;
  /** 罐容，单位吨 */
  capacity: number;
  /** 可承运油品 */
  fuels: string[];
}

export interface Fuel {
  name: string;
}

/** 计划到达时段（左闭右开的毫秒时间戳） */
export interface Slot {
  id: string;
  label: string;
  /** 相对当天 00:00 的开始小时 */
  startHour: number;
  /** 相对当天 00:00 的结束小时 */
  endHour: number;
}

export interface Occupancy {
  id: string;
  orderId: string;
  truckId: string;
  fuel: string;
  /** 预占/占用罐容，单位吨 */
  tons: number;
  /** 计划到达窗口起点（含） */
  windowStart: string;
  /** 计划到达窗口终点（不含） */
  windowEnd: string;
  status: OccupancyStatus;
  createdAt: string;
  /** 状态变化留痕：装车确认 / 撤单释放 / 在途失败释放 / 到站释放 */
  releasedAt?: string;
  releaseReason?: "撤单" | "在途失败" | "到站";
  confirmedAt?: string;
}

export interface OrderEvent {
  at: string;
  text: string;
}

export interface Order {
  id: string;
  station: string;
  fuel: string;
  /** 配送吨数 */
  tons: number;
  arriveDate: string;
  slotId: string;
  notes: string;
  status: OrderStatus;
  createdAt: string;
  /** 旧台账迁移来源标记 */
  migrated?: boolean;
  events: OrderEvent[];
}

export type ConflictCode =
  | "OVERLOAD"
  | "OVER_LIMIT"
  | "FUEL_MISMATCH"
  | "FUEL_MIX"
  | "STAGE";

export interface DispatchConflict {
  code: ConflictCode;
  /** 冲突涉及的对方配送单（撞车 / 混装时给出） */
  otherOrderId?: string;
  message: string;
}

/** 派车草稿：冲突时保留，写入中断后可接着完成 */
export interface DispatchDraft {
  orderId: string;
  truckId: string;
  tons: number;
  arriveDate: string;
  slotId: string;
  fuel: string;
  /** 最近一次校验出的冲突说明（用于页面提示） */
  conflicts: DispatchConflict[];
  updatedAt: string;
}

export interface CreateDraft {
  station: string;
  fuel: string;
  tons: number;
  arriveDate: string;
  slotId: string;
  notes: string;
  updatedAt: string;
}

export interface Notice {
  id: string;
  kind: "info" | "warn" | "success";
  message: string;
  createdAt: string;
}

/** 调度台账：一张整车 + 占用明细的聚合，任何写入都整体版本化提交 */
export interface DispatchLedger {
  version: 1;
  /** 单调递增，乐观锁：提交时必须与读取时一致 */
  seq: number;
  trucks: Truck[];
  orders: Order[];
  occupancies: Occupancy[];
  meta: {
    /** 旧数据迁移是否已完成（只迁一次，状态随台账原子落盘） */
    legacyMigrated: boolean;
    /** 首建台账时是否播种过演示数据 */
    seeded: boolean;
  };
}

/** localStorage 中的写写前记录：提交半途中断时凭它补全 */
export interface PendingCommit {
  ledger: DispatchLedger;
  reason: string;
  savedAt: string;
}

export interface StaleWriteError {
  name: "StaleWriteError";
  expectedSeq: number;
  actualSeq: number;
}
