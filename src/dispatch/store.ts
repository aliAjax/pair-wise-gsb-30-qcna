import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { bootstrapLedger } from "./bootstrap";
import {
  checkDispatch,
  findOrder,
  orderActiveOccupancies,
  overlappingOccupancies,
  truckWindowUsage
} from "./conflicts";
import {
  FUELS,
  SLOTS,
  STATIONS,
  STORAGE_KEYS,
  TRUCKS,
  arrivalWindow,
  getSlot,
  todayISO
} from "./domain";
import { commitLedger, isStaleWriteError, readLedgerState } from "./storage";
import type {
  CreateDraft,
  DispatchConflict,
  DispatchDraft,
  DispatchLedger,
  Notice,
  Occupancy,
  OccupancyStatus,
  Order,
  OrderEvent,
  OrderStatus
} from "./types";

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}

function loadDrafts(): Record<string, DispatchDraft> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.drafts) || "{}") as Record<string, DispatchDraft>;
  } catch {
    return {};
  }
}

function saveDrafts(drafts: Record<string, DispatchDraft>): void {
  localStorage.setItem(STORAGE_KEYS.drafts, JSON.stringify(drafts));
}

function loadCreateDraft(): CreateDraft {
  const blank: CreateDraft = {
    station: STATIONS[0],
    fuel: FUELS[0].name,
    tons: 10,
    arriveDate: todayISO(),
    slotId: SLOTS[0].id,
    notes: "",
    updatedAt: ""
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.createDraft);
    if (!raw) return blank;
    return { ...blank, ...(JSON.parse(raw) as Partial<CreateDraft>) };
  } catch {
    return blank;
  }
}

export class AbortMutation extends Error {
  constructor() {
    super("abort");
    this.name = "AbortMutation";
  }
}

export const useDispatchStore = defineStore("dispatch", () => {
  // ---- 状态 ----
  const ledger = ref<DispatchLedger>({
    version: 1,
    seq: 0,
    trucks: [],
    orders: [],
    occupancies: [],
    meta: { legacyMigrated: false, seeded: false }
  });
  const drafts = ref<Record<string, DispatchDraft>>(loadDrafts());
  const createDraft = ref<CreateDraft>(loadCreateDraft());
  const notices = ref<Notice[]>([]);
  const bootstrapped = ref(false);

  // 车辆看板选中的到达时段（列表 / 汇总跟随该时段的最新占用）
  const boardDate = ref(todayISO());
  const boardSlotId = ref(SLOTS[0].id);
  const stationFilter = ref("全部油站");
  const statusFilter = ref("全部状态");

  // ---- 提示 ----
  function pushNotice(kind: Notice["kind"], message: string): void {
    notices.value = [{ id: uid("notice"), kind, message, createdAt: now() }, ...notices.value].slice(0, 8);
  }
  function dismissNotice(id: string): void {
    notices.value = notices.value.filter((item) => item.id !== id);
  }

  // ---- 启动（幂等）：建账 / 恢复 WAL / 只迁一次旧数据 ----
  function bootstrap(): void {
    if (bootstrapped.value) return;
    const result = bootstrapLedger();
    ledger.value = result.ledger;
    result.notices.forEach((item) => pushNotice(item.kind, item.message));
    bootstrapped.value = true;
  }

  /** 其它窗口写入后，以最新台账覆盖本窗口视图（列表 / 汇总 / 提示跟随最新占用） */
  function reloadFromStorage(reason: string): void {
    const current = ledger.value;
    const { ledger: latest, pending } = readLedgerState();
    if (pending) {
      // 另一窗口提交到一半本窗口读到中间态：等它的下一次 storage 事件即可，不采用半成品
      return;
    }
    if (!latest) return;
    if (latest.seq !== current.seq) {
      ledger.value = latest;
      pushNotice("info", `${reason}，调度台账已刷新到最新占用（版本 #${latest.seq}）。`);
    }
  }

  /**
   * 事务式修改：读最新版本 → 改动 → 乐观锁提交。
   * 序号冲突（两个窗口同时保存）时重读重算，最多 3 轮，保证后到者不会盖掉先到者的占用。
   */  function mutate<T>(
    reason: string,
    apply: (draft: DispatchLedger) => T,
    options: { maxRetries?: number } = {}
  ): T | undefined {
    const maxRetries = options.maxRetries ?? 3;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const base = readLedgerState().ledger ?? ledger.value;
      const working: DispatchLedger = structuredClone(base);
      working.seq = base.seq + 1;
      let result: T;
      try {
        result = apply(working);
      } catch (error) {
        if (error instanceof AbortMutation) return undefined;
        throw error;
      }
      try {
        const committed = commitLedger(base.seq, working, reason);
        ledger.value = committed;
        return result;
      } catch (error) {
        if (isStaleWriteError(error) && attempt < maxRetries) {
          attempt += 1;
          ledger.value = readLedgerState().ledger ?? ledger.value;
          continue;
        }
        if (isStaleWriteError(error)) {
          pushNotice(
            "warn",
            "另一个调度窗口正在连续保存，本次操作未能并入最新台账。请确认车辆占用后重试，原有记录未受影响。"
          );
          return undefined;
        }
        throw error;
      }
    }
  }

  // ---- 派车草稿 ----
  function upsertDraft(orderId: string, patch: Partial<Omit<DispatchDraft, "orderId">>): void {
    const current = drafts.value[orderId];
    const next: DispatchDraft = {
      orderId,
      truckId: patch.truckId ?? current?.truckId ?? TRUCKS[0].id,
      tons: patch.tons ?? current?.tons ?? 0,
      arriveDate: patch.arriveDate ?? current?.arriveDate ?? todayISO(),
      slotId: patch.slotId ?? current?.slotId ?? SLOTS[0].id,
      fuel: patch.fuel ?? current?.fuel ?? "",
      conflicts: patch.conflicts ?? current?.conflicts ?? [],
      updatedAt: now()
    };
    drafts.value = { ...drafts.value, [orderId]: next };
    saveDrafts(drafts.value);
  }

  function discardDraft(orderId: string): void {
    if (!drafts.value[orderId]) return;
    const next = { ...drafts.value };
    delete next[orderId];
    drafts.value = next;
    saveDrafts(next);
  }

  /** 草稿上的实时冲突（台账被其它窗口改动后，页面提示跟随最新占用） */
  function draftConflicts(orderId: string): DispatchConflict[] {
    const draft = drafts.value[orderId];
    const order = findOrder(ledger.value, orderId);
    if (!draft || !order) return draft?.conflicts ?? [];
    return checkDispatch(
      ledger.value,
      order,
      draft.truckId,
      draft.tons,
      draft.arriveDate,
      draft.slotId
    );
  }

  function draftFor(orderId: string): DispatchDraft | undefined {
    return drafts.value[orderId];
  }

  // ---- 派车：预占车辆与罐容，冲突则保留草稿且不产生台账版本 ----
  function reserve(orderId: string): void {
    const draft = drafts.value[orderId];
    if (!draft) {
      pushNotice("warn", "请先在调度台选择油罐车与计划到达时段。");
      return;
    }
    // 冲突信息从事务内带出（冲突时中止提交，避免无意义的版本号与半份记录）
    const conflictBox: { value: DispatchConflict[] | null } = { value: null };
    const result = mutate(`派车预占 ${orderId}`, (work) => {
      const order = findOrder(work, orderId);
      if (!order) throw new AbortMutation();
      const conflicts = checkDispatch(
        work,
        order,
        draft.truckId,
        draft.tons,
        draft.arriveDate,
        draft.slotId
      );
      if (conflicts.length > 0) {
        conflictBox.value = conflicts;
        throw new AbortMutation();
      }
      const truck = work.trucks.find((item) => item.id === draft.truckId)!;
      const { start, end } = arrivalWindow(draft.arriveDate, draft.slotId);
      const occupancy: Occupancy = {
        id: uid("occ"),
        orderId,
        truckId: truck.id,
        fuel: order.fuel,
        tons: draft.tons,
        windowStart: start,
        windowEnd: end,
        status: "预占",
        createdAt: now()
      };
      work.occupancies.push(occupancy);
      order.status = "已预占";
      order.arriveDate = draft.arriveDate;
      order.slotId = draft.slotId;
      order.events.push({
        at: now(),
        text: `派车预占：${truck.name}，${draft.tons} 吨，${getSlot(draft.slotId).label} 到达（等待装车确认）`
      });
      return occupancy.id;
    });

    if (conflictBox.value) {
      upsertDraft(orderId, { conflicts: conflictBox.value });
      pushNotice(
        "warn",
        `派车存在冲突，草稿已保留：${conflictBox.value.map((c) => c.message).join("；")}`
      );
      return;
    }
    if (result) {
      discardDraft(orderId);
      pushNotice("success", "已按计划到达时段预占油罐车与罐容，装车完成后请确认占用。");
    }
  }

  // ---- 装车后确认占用：预占 → 占用 ----
  function confirmLoading(orderId: string): void {
    const guard = { failed: false };
    const ok = mutate(`装车确认 ${orderId}`, (work) => {
      const order = findOrder(work, orderId);
      const actives = order ? work.occupancies.filter((o) => o.orderId === orderId && o.status !== "已释放") : [];
      if (!order || order.status !== "已预占" || actives.length === 0) {
        guard.failed = true;
        throw new AbortMutation();
      }
      const ts = now();
      actives.forEach((item) => {
        item.status = "占用" satisfies OccupancyStatus;
        item.confirmedAt = ts;
      });
      order.status = "装车中";
      order.events.push({ at: ts, text: "装车完成，车辆与罐容占用已确认" });
      return true;
    });
    if (guard.failed || !ok) pushNotice("warn", "只有已预占的配送单可以确认装车。");
    else pushNotice("success", "装车确认成功，占用已生效。");
  }

  /** 发车：装车中 → 运输中（占用仍保持，罐容继续锁定） */
  function depart(orderId: string): void {
    transition(orderId, ["装车中"], "运输中", "车辆发运，在途保持罐容占用", "只有装车完成的配送单可以发车。");
  }

  /** 到站签收：运输中 → 已到站，占用随到站释放 */
  function arrive(orderId: string): void {
    const guard = { failed: false };
    const done = mutate(`到站释放 ${orderId}`, (work) => {
      const order = findOrder(work, orderId);
      if (!order || order.status !== "运输中") {
        guard.failed = true;
        throw new AbortMutation();
      }
      const ts = now();
      const actives = work.occupancies.filter((o) => o.orderId === orderId && o.status !== "已释放");
      releaseOccupancies(work, actives, "到站", ts);
      order.status = "已到站";
      order.events.push({ at: ts, text: "已到站签收，车辆与罐容占用释放" });
      return true;
    });
    if (guard.failed || !done) pushNotice("warn", "只有运输中的配送单可以登记到站。");
    else pushNotice("success", "到站已签收，车辆与罐容已释放。");
  }

  /** 在途失败：运输中 → 在途失败，释放占用（车辆可重新安排） */
  function failInTransit(orderId: string): void {
    const guard = { failed: false };
    const done = mutate(`在途失败释放 ${orderId}`, (work) => {
      const order = findOrder(work, orderId);
      if (!order || order.status !== "运输中") {
        guard.failed = true;
        throw new AbortMutation();
      }
      const ts = now();
      const actives = work.occupancies.filter((o) => o.orderId === orderId && o.status !== "已释放");
      releaseOccupancies(work, actives, "在途失败", ts);
      order.status = "在途失败";
      order.events.push({ at: ts, text: "在途失败，车辆与罐容占用已释放" });
      return true;
    });
    if (guard.failed || !done) pushNotice("warn", "只有运输中的配送单可以登记在途失败。");
    else pushNotice("warn", "已登记在途失败，车辆与罐容已释放，可重新安排其它配送单。");
  }

  /** 撤单：发车前（待派车 / 已预占 / 装车中）允许撤单，释放预占或占用 */
  function cancelOrder(orderId: string): void {
    const done = mutate(`撤单释放 ${orderId}`, (work) => {
      const order = findOrder(work, orderId);
      if (!order || !["待派车", "已预占", "装车中"].includes(order.status)) {
        throw new AbortMutation();
      }
      const ts = now();
      const actives = work.occupancies.filter((o) => o.orderId === orderId && o.status !== "已释放");
      releaseOccupancies(work, actives, "撤单", ts);
      order.status = "撤单";
      order.events.push({ at: ts, text: actives.length ? "撤单，预占/占用已释放" : "撤单（派车前撤单，无占用）" });
      return true;
    });
    if (done) {
      discardDraft(orderId);
      pushNotice("info", "配送单已撤销，对应车辆与罐容已释放。");
    } else {
      pushNotice("warn", "运输中或已完结的配送单不能撤单，请使用到站或在途失败。");
    }
  }

  function releaseOccupancies(
    work: DispatchLedger,
    items: Occupancy[],
    reason: "撤单" | "在途失败" | "到站",
    ts: string
  ): void {
    items.forEach((item) => {
      item.status = "已释放";
      item.releasedAt = ts;
      item.releaseReason = reason;
    });
  }

  function transition(
    orderId: string,
    allowed: OrderStatus[],
    next: OrderStatus,
    eventText: string,
    warnText: string
  ): void {
    const guard = { failed: false };
    const done = mutate(`${next}流转 ${orderId}`, (work) => {
      const order = findOrder(work, orderId);
      if (!order || !allowed.includes(order.status)) {
        guard.failed = true;
        throw new AbortMutation();
      }
      order.status = next;
      order.events.push({ at: now(), text: eventText });
      return true;
    });
    if (guard.failed || !done) pushNotice("warn", warnText);
  }

  // ---- 建单 ----
  function saveCreateDraft(patch: Partial<CreateDraft>): void {
    createDraft.value = { ...createDraft.value, ...patch, updatedAt: now() };
    localStorage.setItem(STORAGE_KEYS.createDraft, JSON.stringify(createDraft.value));
  }

  function clearCreateDraft(): void {
    const blank: CreateDraft = {
      station: STATIONS[0],
      fuel: FUELS[0].name,
      tons: 10,
      arriveDate: todayISO(),
      slotId: SLOTS[0].id,
      notes: "",
      updatedAt: ""
    };
    createDraft.value = blank;
    localStorage.removeItem(STORAGE_KEYS.createDraft);
  }

  function createOrder(): void {
    const draftSnapshot = { ...createDraft.value };
    if (!draftSnapshot.station || !draftSnapshot.fuel || draftSnapshot.tons <= 0) {
      pushNotice("warn", "请完整填写油站、油品和大于 0 的配送吨数。");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draftSnapshot.arriveDate)) {
      pushNotice("warn", "请填写正确的计划到达日期。");
      return;
    }
    const done = mutate("创建配送单", (work) => {
      const ts = now();
      const order: Order = {
        id: uid("order"),
        station: draftSnapshot.station,
        fuel: draftSnapshot.fuel,
        tons: draftSnapshot.tons,
        arriveDate: draftSnapshot.arriveDate,
        slotId: draftSnapshot.slotId,
        notes: draftSnapshot.notes || "暂无备注",
        status: "待派车",
        createdAt: ts,
        events: [{ at: ts, text: "创建配送单，等待派车预占" } satisfies OrderEvent]
      };
      work.orders.unshift(order);
      return order.id;
    });
    if (done) {
      clearCreateDraft();
      pushNotice("success", "配送单已创建，可在列表中派车；派车时将先预占车辆与罐容。");
    }
  }

  // ---- 视图派生：列表、汇总、看板全部跟随最新占用 ----
  const activeTruckIds = computed(() => new Set(ledger.value.trucks.map((t) => t.id)));

  const filteredOrders = computed(() => {
    return ledger.value.orders.filter((order) => {
      if (stationFilter.value !== "全部油站" && order.station !== stationFilter.value) return false;
      if (statusFilter.value !== "全部状态" && order.status !== statusFilter.value) return false;
      return true;
    });
  });

  const draftCount = computed(() => Object.keys(drafts.value).length);

  function usageOf(truckId: string) {
    return truckWindowUsage(ledger.value, truckId, boardDate.value, boardSlotId.value);
  }

  function occupanciesForOrder(orderId: string): Occupancy[] {
    return orderActiveOccupancies(ledger.value, orderId);
  }

  function truckName(truckId: string): string {
    return ledger.value.trucks.find((t) => t.id === truckId)?.name ?? "未知车辆";
  }

  function orderById(orderId: string): Order | undefined {
    return findOrder(ledger.value, orderId);
  }

  /** 某车某时段可排的剩余吨数（派车表单里提示） */
  function remainingForTruck(truckId: string, arriveDate: string, slotId: string, excludeOrderId?: string): number {
    const truck = ledger.value.trucks.find((t) => t.id === truckId);
    if (!truck) return 0;
    const used = overlappingOccupancies(ledger.value, truckId, arriveDate, slotId, excludeOrderId).reduce(
      (sum, item) => sum + item.tons,
      0
    );
    return Math.max(0, truck.capacity - used);
  }

  // ---- 汇总指标 ----
  const metrics = computed(() => {
    const orders = ledger.value.orders;
    const pending = orders.filter((o) => o.status === "待派车").length;
    const reserved = orders.filter((o) => o.status === "已预占" || o.status === "装车中").length;
    const inTransit = orders.filter((o) => o.status === "运输中").length;
    // 当前看板时段：所有车辆合计占用率（预占 + 占用）
    const totalCap = ledger.value.trucks.reduce((s, t) => s + t.capacity, 0);
    const usedNow = ledger.value.trucks.reduce(
      (s, t) => s + truckWindowUsage(ledger.value, t.id, boardDate.value, boardSlotId.value).used,
      0
    );
    const rate = totalCap === 0 ? 0 : Math.round((usedNow / totalCap) * 100);
    return { total: orders.length, pending, reserved, inTransit, rate, usedNow, totalCap };
  });

  return {
    // state
    ledger,
    drafts,
    createDraft,
    notices,
    bootstrapped,
    boardDate,
    boardSlotId,
    stationFilter,
    statusFilter,
    activeTruckIds,
    // lifecycle
    bootstrap,
    reloadFromStorage,
    // notices
    pushNotice,
    dismissNotice,
    // drafts
    upsertDraft,
    discardDraft,
    draftConflicts,
    draftFor,
    // operations
    reserve,
    confirmLoading,
    depart,
    arrive,
    failInTransit,
    cancelOrder,
    createOrder,
    saveCreateDraft,
    clearCreateDraft,
    // views
    filteredOrders,
    draftCount,
    usageOf,
    occupanciesForOrder,
    truckName,
    orderById,
    remainingForTruck,
    metrics
  };
});
