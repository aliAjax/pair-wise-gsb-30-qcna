import { applyOp, createEmptyLedger, uid } from "./domain";
import { buildFleet, buildSeedData } from "./seed";
import type { AppliedRef, Assignment, DeliveryOrder, Ledger, Operation, Truck } from "./types";

// v1：旧系统（每张配送单各自排车，整条 records 数组直接覆盖，并发保存互相盖写）
export const LEGACY_KEY = "hxwlfront-19-oil-delivery";
// v2：调度台账（车辆 / 配送单 / 排车在同一份原子写入的台账里）
const LEDGER_KEY = "hxwlfront-19-oil-dispatch-ledger-v2";
const JOURNAL_PREFIX = "hxwlfront-19-oil-dispatch-journal-v2:";
const APPLIED_KEY = "hxwlfront-19-oil-dispatch-applied-v2";
// 迁移闸门：迁移日志一旦写下就置位，重开只会回放，绝不会迁第二次
const MIGRATION_DONE_KEY = "hxwlfront-19-oil-dispatch-migrated-v2";
const APPLIED_LIMIT = 100;
const LOCK_NAME = "hxwlfront-19-oil-dispatch-v2";

function safeParse<T>(raw: string | null): T | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function readLedger(): Ledger | undefined {
  return safeParse<Ledger>(localStorage.getItem(LEDGER_KEY));
}

function writeLedger(ledger: Ledger) {
  // 单 key 写入是浏览器原子操作：读到的要么是旧台账要么是新台账，不会出现半份
  localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
}

function readApplied(): AppliedRef[] {
  return safeParse<AppliedRef[]>(localStorage.getItem(APPLIED_KEY)) ?? [];
}

function writeApplied(refs: AppliedRef[]) {
  localStorage.setItem(APPLIED_KEY, JSON.stringify(refs.slice(-APPLIED_LIMIT)));
}

/** 未决日志：写了日志但台账还没发布，就是"写入中断"现场 */
function pendingJournalOps(): Operation[] {
  const ops: Operation[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(JOURNAL_PREFIX)) {
      const op = safeParse<Operation>(localStorage.getItem(key));
      if (op) ops.push(op);
    }
  }
  return ops.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
}

function journalKey(opId: string) {
  return `${JOURNAL_PREFIX}${opId}`;
}

function appendApplied(op: Operation) {
  writeApplied([...readApplied(), { opId: op.id, type: op.type }]);
}

export interface BootstrapResult {
  ledger: Ledger;
  recovered: Operation[];
  migratedCount: number;
  seeded: boolean;
  corruptLegacy: boolean;
}

/**
 * 打开调度台（按顺序）：
 * 1) 回放未决日志 —— 上次写台账前被关掉/崩溃的操作，重开接着完成；
 * 2) 旧数据迁移 —— 迁移闸门保证只迁一次，旧 id/状态/原始记录全部保留；
 * 3) 全新环境 —— 写入内置示例台账。
 */
export function bootstrap(): BootstrapResult {
  const result: BootstrapResult = {
    ledger: readLedger() ?? createEmptyLedger(new Date().toISOString()),
    recovered: [],
    migratedCount: 0,
    seeded: false,
    corruptLegacy: false
  };

  // 1) 崩溃恢复
  const appliedIds = new Set(readApplied().map((ref) => ref.opId));
  for (const op of pendingJournalOps()) {
    if (appliedIds.has(op.id)) {
      localStorage.removeItem(journalKey(op.id));
      continue;
    }
    result.ledger = applyOp(result.ledger, op);
    appendApplied(op);
    if (op.type === "migrate") {
      // 迁移日志已落而闸门未置（恰在中间断电）—— 补置闸门，确保只迁一次
      localStorage.setItem(MIGRATION_DONE_KEY, "1");
      result.migratedCount = (op.payload as { orders: unknown[] }).orders.length;
    }
    localStorage.removeItem(journalKey(op.id));
    result.recovered.push(op);
  }
  if (result.recovered.length > 0) writeLedger(result.ledger);

  // 2) 旧台账一次性迁移（原始数据留在 LEGACY_KEY 不动，作为留底）
  const legacyRaw = localStorage.getItem(LEGACY_KEY);
  if (localStorage.getItem(MIGRATION_DONE_KEY) !== "1" && legacyRaw !== null) {
    const parsed = safeParse<unknown[]>(legacyRaw);
    if (Array.isArray(parsed)) {
      const op = buildMigrationOp(parsed);
      if (op) {
        // 日志先落盘 → 置闸门 → 发布台账；任何一步中断，重开都不会重复迁移
        localStorage.setItem(journalKey(op.id), JSON.stringify(op));
        result.ledger = applyOp(result.ledger, op);
        localStorage.setItem(MIGRATION_DONE_KEY, "1");
        writeLedger(result.ledger);
        appendApplied(op);
        localStorage.removeItem(journalKey(op.id));
        result.migratedCount = (op.payload as { orders: DeliveryOrder[] }).orders.length;
      } else {
        result.corruptLegacy = true;
        localStorage.setItem(MIGRATION_DONE_KEY, "1");
      }
    } else if (legacyRaw !== "") {
      result.corruptLegacy = true;
      localStorage.setItem(MIGRATION_DONE_KEY, "1");
    } else {
      localStorage.setItem(MIGRATION_DONE_KEY, "1");
    }
  }

  // 3) 全新环境：内置示例
  if (result.ledger.orders.length === 0 && result.ledger.trucks.length === 0) {
    const now = new Date().toISOString();
    const seed = buildSeedData(now);
    const op: Operation = {
      id: uid("op"),
      type: "seed",
      at: now,
      payload: seed
    };
    localStorage.setItem(journalKey(op.id), JSON.stringify(op));
    result.ledger = applyOp(result.ledger, op);
    writeLedger(result.ledger);
    appendApplied(op);
    localStorage.removeItem(journalKey(op.id));
    result.seeded = true;
  }

  return result;
}

/**
 * v1 records → v2 迁移操作。
 * 旧 id、状态、备注原样保留；旧三态直接映射进新状态机；原始整条记录挂在 legacy 留底。
 * 同时补入标准车队，保证旧单迁过来有车可派。
 */
function buildMigrationOp(legacy: unknown[]): Operation | undefined {
  const orders: DeliveryOrder[] = [];
  for (let i = 0; i < legacy.length; i += 1) {
    const raw = legacy[i] as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id : `legacy-${i + 1}`;
    const legacyDate = typeof raw.arriveAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.arriveAt)
      ? raw.arriveAt
      : "2026-07-01";
    const fuel = (["92号汽油", "95号汽油", "柴油"] as const).includes(raw.fuel as never)
      ? (raw.fuel as DeliveryOrder["fuel"])
      : "92号汽油";
    const status: DeliveryOrder["status"] =
      raw.status === "运输中" || raw.status === "已到站" ? raw.status : "待发车";
    orders.push({
      id,
      station: typeof raw.station === "string" ? raw.station : "未知油站",
      fuel,
      tons: Number(raw.tons) || 0,
      arriveDate: legacyDate,
      phase: "morning",
      windowStart: `${legacyDate}T08:00`,
      windowEnd: `${legacyDate}T12:00`,
      notes: typeof raw.notes === "string" ? raw.notes : "",
      status,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      legacy: raw
    });
  }
  if (orders.length === 0) return undefined;
  const now = new Date().toISOString();
  const trucks: Truck[] = buildFleet().map((truck) => ({ ...truck, fuels: [...truck.fuels], status: "可用" as Truck["status"] }));
  const payload: { trucks: Truck[]; orders: DeliveryOrder[]; assignments: Assignment[]; migratedAt: string } = {
    trucks,
    orders,
    assignments: [],
    migratedAt: now
  };
  return { id: uid("op"), type: "migrate", at: now, payload };
}

export interface CommitOptions {
  /** 锁内基于最新台账做二次校验（如冲突计算），返回值合并进操作 payload */
  prepare?: (ledger: Ledger) => Record<string, unknown>;
}

/**
 * 提交一条状态变更。
 * Web Locks 跨窗口互斥 → 锁内重读最新台账 → prepare 校验 → 写日志 → 发布 → 清日志。
 * 两个窗口同时派车时，后一个在锁内看到的必是前一个发布后的最新占用。
 */
export async function commit(
  build: (now: string) => { type: Operation["type"]; payload?: unknown },
  options: CommitOptions = {}
): Promise<Ledger> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks?.request) {
    return await new Promise<Ledger>((resolve, reject) => {
      locks.request(LOCK_NAME, () => {
        try {
          resolve(commitLocked(build, options));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
  return commitLocked(build, options);
}

function commitLocked(
  build: (now: string) => { type: Operation["type"]; payload?: unknown },
  options: CommitOptions
): Ledger {
  // 锁内重读：拿到的一定是最新台账
  const ledger = readLedger() ?? createEmptyLedger(new Date().toISOString());
  const draft = build(new Date().toISOString());
  const extra = options.prepare?.(ledger);
  const op: Operation = {
    id: uid("op"),
    type: draft.type,
    at: new Date().toISOString(),
    payload: extra ? { ...(draft.payload as Record<string, unknown> | undefined), ...extra } : draft.payload
  };
  // 第一步：日志先落盘。此后无论何时被关掉，重开都能接着完成这条操作
  localStorage.setItem(journalKey(op.id), JSON.stringify(op));
  // 第二步：发布台账（单 key 原子写，不会留半份）
  const next = applyOp(ledger, op);
  writeLedger(next);
  // 第三步：登记已应用、清日志；在这之前中断也没关系，回放是幂等的
  appendApplied(op);
  localStorage.removeItem(journalKey(op.id));
  return next;
}

/** 台账键名，供页面监听跨窗口变更 */
export const LEDGER_STORAGE_KEY = LEDGER_KEY;
