import { STORAGE_KEYS, TRUCKS, getSlot, todayISO } from "./domain";
import { clearPending, readLedgerState, writeLedger, writePending } from "./storage";
import type { DispatchLedger, Order, OrderEvent, OrderStatus } from "./types";

/** 旧版整单记录（迁移时只读） */
interface LegacyRecord {
  id?: string;
  station?: string;
  fuel?: string;
  tons?: number;
  arriveAt?: string;
  status?: string;
  notes?: string;
  createdAt?: string;
}

export interface BootstrapResult {
  ledger: DispatchLedger;
  /** 中断恢复 / 迁移结果等需要向用户交代的说明 */
  notices: { kind: "info" | "warn" | "success"; message: string }[];
}

function emptyLedger(): DispatchLedger {
  return {
    version: 1,
    seq: 0,
    trucks: TRUCKS.map((truck) => ({ ...truck, fuels: [...truck.fuels] })),
    orders: [],
    occupancies: [],
    meta: { legacyMigrated: false, seeded: false }
  };
}

/** 旧状态映射：保留原状态语义；无法对应的一律进待派车，原值写进事件流不丢失 */
function mapLegacyStatus(rawStatus?: string): { status: OrderStatus; event: string } {
  const original = rawStatus || "";
  switch (original) {
    case "待发车":
      return { status: "待派车", event: `旧台账状态「${original}」迁移为「待派车」` };
    case "运输中":
      return { status: "运输中", event: `旧台账状态「${original}」原样保留（迁移前在途车辆，无占用记录）` };
    case "已到站":
      return { status: "已到站", event: `旧台账状态「${original}」原样保留` };
    default:
      return {
        status: "待派车",
        event: `旧台账未知状态「${original}」迁移为「待派车」`
      };
  }
}

function migrateLegacy(): { orders: Order[]; count: number } | null {
  const raw = localStorage.getItem(STORAGE_KEYS.legacy);
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 旧数据损坏：不覆盖、不删除，交给调用方提示，保证旧记录仍在
    return { orders: [], count: -1 };
  }
  if (!Array.isArray(parsed)) return { orders: [], count: -1 };
  const records = parsed as LegacyRecord[];
  const orders: Order[] = records.map((record, index) => {
    const { status, event } = mapLegacyStatus(record.status);
    const arriveDate = /^\d{4}-\d{2}-\d{2}/.test(record.arriveAt || "")
      ? (record.arriveAt as string).slice(0, 10)
      : todayISO();
    const events: OrderEvent[] = [];
    events.push({
      at: record.createdAt || new Date().toISOString(),
      text: `从旧台账迁移：${record.notes || "无备注"}`
    });
    events.push({ at: new Date().toISOString(), text: event });
    return {
      id: record.id || `seed-${index + 1}`,
      station: String(record.station || ""),
      fuel: String(record.fuel || ""),
      tons: Number(record.tons || 0),
      arriveDate,
      slotId: "morning",
      notes: record.notes || "旧台账迁移（无备注）",
      status,
      createdAt: record.createdAt || new Date().toISOString(),
      migrated: true,
      events
    };
  });
  return { orders, count: orders.length };
}

function seedOrders(): Order[] {
  const now = Date.now();
  return [
    {
      id: "seed-1",
      station: "城东站",
      fuel: "92号汽油",
      tons: 18,
      arriveDate: todayISO(),
      slotId: "morning",
      notes: "车辆已出库",
      status: "运输中",
      createdAt: new Date(now - 86400000).toISOString(),
      events: [{ at: new Date(now - 86400000).toISOString(), text: "系统演示配送单" }]
    },
    {
      id: "seed-2",
      station: "机场站",
      fuel: "柴油",
      tons: 12,
      arriveDate: todayISO(),
      slotId: "morning",
      notes: "等待装车",
      status: "待派车",
      createdAt: new Date().toISOString(),
      events: [{ at: new Date().toISOString(), text: "系统演示配送单" }]
    }
  ];
}

/**
 * 台账引导（只执行一次的初始化逻辑放在这里，状态随台账落盘）：
 * 1. 未完成的 WAL 先补全 —— 写入中断后重开接着完成
 * 2. 迁移旧台账（只迁一次，迁移成功后置 legacyMigrated；旧键原样保留）
 * 3. 既无台账也无旧数据时播种演示数据
 */
export function bootstrapLedger(): BootstrapResult {
  const notices: BootstrapResult["notices"] = [];
  const { ledger: stored, pending } = readLedgerState();

  // 1) 崩溃恢复：pending 存在说明上次提交在主台账落盘前中断，按 WAL 补全
  if (pending) {
    writeLedger(pending.ledger);
    clearPending();
    notices.push({
      kind: "warn",
      message: `检测到上次写入在「${pending.reason}」时中断，已根据写前记录补全，未产生半份调度记录。`
    });
  }

  const ledger = readLedgerState().ledger;
  if (ledger) return { ledger, notices };

  // 2) 首次建账：迁移旧台账
  const fresh = emptyLedger();
  const migration = migrateLegacy();
  if (migration) {
    if (migration.count === -1) {
      notices.push({
        kind: "warn",
        message: "旧台账数据无法解析，已保留原数据未做改动；本次以空台账启动，请人工核对旧记录。"
      });
    } else {
      fresh.orders = migration.orders;
      notices.push({
        kind: "success",
        message: `已将旧台账 ${migration.count} 张配送单迁入新调度台账（仅迁移一次），原记录与状态均保留，旧数据未删除。`
      });
    }
    fresh.meta.legacyMigrated = true;
  } else {
    // 3) 无旧数据：播种演示配送单
    fresh.orders = seedOrders();
    fresh.meta.seeded = true;
  }

  fresh.seq = 1;
  // 首次建账同样走 WAL：首次写入也允许中断恢复
  writePending({ ledger: fresh, reason: "建立调度台账", savedAt: new Date().toISOString() });
  writeLedger(fresh);
  clearPending();
  return { ledger: fresh, notices };
}

/** 供自测与极端修复使用：读取某槽位标签 */
export function describeSlot(slotId: string): string {
  return getSlot(slotId).label;
}
