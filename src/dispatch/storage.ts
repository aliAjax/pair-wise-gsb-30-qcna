import { STORAGE_KEYS } from "./domain";
import type { DispatchLedger, PendingCommit, StaleWriteError } from "./types";

function storage(): Storage {
  // 浏览器环境用 localStorage；Node 自测时由测试文件注入全局 memory storage
  return globalThis.localStorage;
}

export function makeStaleError(expectedSeq: number, actualSeq: number): StaleWriteError {
  return { name: "StaleWriteError", expectedSeq, actualSeq };
}

export function isStaleWriteError(error: unknown): error is StaleWriteError {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "StaleWriteError";
}

function readJSON<T>(key: string): T | null {
  const raw = storage().getItem(key);
  if (raw == null) return null;
  return JSON.parse(raw) as T;
}

/**
 * 读台账，不在此处做恢复决策，只如实返回「主台账 + 未完成的写写前记录」。
 * pending 存在意味着上一次写入在 WAL 落盘后、主台账落盘前中断（关机 / 崩溃 / 强杀）。
 */
export function readLedgerState(): { ledger: DispatchLedger | null; pending: PendingCommit | null } {
  const ledger = readJSON<DispatchLedger>(STORAGE_KEYS.ledger);
  const pending = readJSON<PendingCommit>(STORAGE_KEYS.pending);
  return { ledger, pending };
}

export function writePending(pending: PendingCommit): void {
  storage().setItem(STORAGE_KEYS.pending, JSON.stringify(pending));
}

export function clearPending(): void {
  storage().removeItem(STORAGE_KEYS.pending);
}

export function writeLedger(ledger: DispatchLedger): void {
  // localStorage 对单个 key 的写入是原子的；配合 pending 实现两阶段可恢复提交
  storage().setItem(STORAGE_KEYS.ledger, JSON.stringify(ledger));
}

/**
 * 版本化提交：
 * 1. 校验序号（防两个窗口读到同一版本后互相覆盖）
 * 2. 写 WAL（pending）—— 此后即使中断，重开也能补全
 * 3. 写主台账并清除 WAL
 */
export function commitLedger(expectedSeq: number, next: DispatchLedger, reason: string): DispatchLedger {
  const { ledger } = readLedgerState();
  if (ledger && ledger.seq !== expectedSeq) {
    throw makeStaleError(expectedSeq, ledger.seq);
  }
  writePending({ ledger: next, reason, savedAt: new Date().toISOString() });
  writeLedger(next);
  clearPending();
  return next;
}
