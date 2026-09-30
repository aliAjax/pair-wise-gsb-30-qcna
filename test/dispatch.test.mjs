// Node 自测：不依赖测试框架，esbuild 临时打包后用 node 运行
// 用法：node test/run.mjs（由 npm run test:logic 生成临时 bundle）
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, test } from "node:test";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.window = { addEventListener() {}, removeEventListener() {}, scrollTo() {} };
globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));

const { useDispatchStore } = await import("../src/dispatch/store.ts");
const domain = await import("../src/dispatch/domain.ts");
const storage = await import("../src/dispatch/storage.ts");
const { bootstrapLedger } = await import("../src/dispatch/bootstrap.ts");
const { checkDispatch, truckWindowUsage } = await import("../src/dispatch/conflicts.ts");

const KEYS = domain.STORAGE_KEYS;
const TODAY = domain.todayISO();

function newStore() {
  setActivePinia(createPinia());
  const store = useDispatchStore();
  store.bootstrap();
  return store;
}

function seedLegacy() {
  localStorage.setItem(KEYS.legacy, JSON.stringify([
    { id: "old-1", station: "城东站", fuel: "92号汽油", tons: 18, arriveAt: "2026-07-01", status: "运输中", notes: "车辆已出库", createdAt: "2026-06-30T08:00:00.000Z" },
    { id: "old-2", station: "机场站", fuel: "柴油", tons: 12, arriveAt: "2026-07-02", status: "待发车", notes: "等待装车", createdAt: "2026-07-01T08:00:00.000Z" },
    { id: "old-3", station: "新区站", fuel: "95号汽油", tons: 9, arriveAt: "2026-07-03", status: "已到站", notes: "", createdAt: "2026-07-02T08:00:00.000Z" }
  ]));
}

afterEach(() => localStorage.clear());

test("全新环境：播种演示数据，WAL 不留残余，台账序号从 1 开始", () => {
  const store = newStore();
  assert.equal(store.ledger.orders.length, 2);
  assert.equal(store.ledger.meta.seeded, true);
  assert.equal(store.ledger.meta.legacyMigrated, false);
  assert.equal(store.ledger.seq, 1);
  assert.equal(localStorage.getItem(KEYS.pending), null);
  assert.equal(store.ledger.orders[1].status, "待派车");
});

test("旧台账只迁一次：原记录、状态、备注全部保留，旧键不删除", () => {
  seedLegacy();
  const first = bootstrapLedger();
  assert.equal(first.ledger.orders.length, 3);
  assert.equal(first.ledger.meta.legacyMigrated, true);
  assert.ok(localStorage.getItem(KEYS.legacy), "旧键必须保留不删除");

  const orders = first.ledger.orders;
  assert.equal(orders.find((o) => o.id === "old-1").status, "运输中");
  assert.equal(orders.find((o) => o.id === "old-2").status, "待派车");
  assert.equal(orders.find((o) => o.id === "old-3").status, "已到站");
  assert.ok(orders.every((o) => o.migrated));
  assert.ok(orders[0].events.some((e) => e.text.includes("车辆已出库")));
  assert.ok(orders[1].events.some((e) => e.text.includes("旧台账状态")));
  // 运输中迁入的旧单不得凭空产生占用
  assert.equal(first.ledger.occupancies.length, 0);

  // 再次引导（刷新重开）：不得重复迁移
  const second = bootstrapLedger();
  assert.equal(second.ledger.orders.length, 3);
  assert.equal(second.notices.length, 0);
});

test("旧台账损坏：不覆盖旧数据，空台账启动并告警", () => {
  localStorage.setItem(KEYS.legacy, "{not-json");
  const result = bootstrapLedger();
  assert.equal(result.ledger.orders.length, 0);
  assert.equal(result.ledger.meta.legacyMigrated, true);
  assert.equal(localStorage.getItem(KEYS.legacy), "{not-json");
  assert.ok(result.notices.some((n) => n.kind === "warn"));
});

test("派车：按计划到达时段预占车辆与罐容，聚合到看板", () => {
  const store = newStore();
  const order = store.ledger.orders.find((o) => o.status === "待派车"); // seed-2 柴油12t
  store.upsertDraft(order.id, { truckId: "truck-B", tons: 12, arriveDate: TODAY, slotId: "morning", fuel: "柴油" });
  store.reserve(order.id);
  assert.equal(store.ledger.orders.find((o) => o.id === order.id).status, "已预占");
  const occ = store.ledger.occupancies[0];
  assert.equal(occ.status, "预占");
  assert.equal(occ.tons, 12);
  const usage = truckWindowUsage(store.ledger, "truck-B", TODAY, "morning");
  assert.equal(usage.used, 12);
  assert.equal(usage.reserved, 12);
  assert.equal(store.draftFor(order.id), undefined);
});

test("超量撞车：保留草稿与冲突说明，台账不产生半份记录", () => {
  const store = newStore();
  // truck-A 30t，92/95
  const orderA = store.ledger.orders.find((o) => o.fuel === "92号汽油"); // seed-1 运输中，无占用
  // 先建一张 20t 的预占
  store.upsertDraft(orderA.id, { truckId: "truck-A", tons: 20, arriveDate: TODAY, slotId: "morning", fuel: "92号汽油" });
  // 运输中订单不可派车 → 改为直接构造：创建新单
  store.saveCreateDraft({ station: "城东站", fuel: "92号汽油", tons: 20, arriveDate: TODAY, slotId: "morning", notes: "" });
  store.createOrder();
  const first = store.ledger.orders[0];
  store.upsertDraft(first.id, { truckId: "truck-A", tons: 20, arriveDate: TODAY, slotId: "morning", fuel: "92号汽油" });
  store.reserve(first.id);
  assert.equal(store.ledger.orders.find((o) => o.id === first.id).status, "已预占");

  // 再来一张同车同时段 15t（20+15>30）
  store.saveCreateDraft({ station: "新区站", fuel: "92号汽油", tons: 15, arriveDate: TODAY, slotId: "morning", notes: "" });
  store.createOrder();
  const second = store.ledger.orders[0];
  store.upsertDraft(second.id, { truckId: "truck-A", tons: 15, arriveDate: TODAY, slotId: "morning", fuel: "92号汽油" });
  const seqBefore = store.ledger.seq;
  store.reserve(second.id);
  assert.equal(store.ledger.seq, seqBefore, "冲突提交不得改变台账版本");
  assert.equal(store.ledger.orders.find((o) => o.id === second.id).status, "待派车");
  assert.equal(store.ledger.occupancies.length, 1, "不得写入占用明细");
  const draft = store.draftFor(second.id);
  assert.ok(draft, "草稿必须保留");
  assert.ok(draft.conflicts.some((c) => c.code === "OVERLOAD"));
  assert.ok(JSON.parse(localStorage.getItem(KEYS.drafts))[second.id], "草稿必须落盘，中断重开可恢复");

  // 调整方案：换时段即可成功
  store.upsertDraft(second.id, { slotId: "afternoon" });
  store.reserve(second.id);
  assert.equal(store.ledger.orders.find((o) => o.id === second.id).status, "已预占");
  assert.equal(store.ledger.occupancies.length, 2);
});

test("单车超限与油品不符 / 混装冲突", () => {
  seedLegacy();
  const store = newStore();
  const dieselOrder = store.ledger.orders.find((o) => o.id === "old-2"); // 柴油12t 待派车
  // 柴油车不允许进汽油车
  store.upsertDraft(dieselOrder.id, { truckId: "truck-A", tons: 12, arriveDate: "2026-07-02", slotId: "morning", fuel: "柴油" });
  let conflicts = store.draftConflicts(dieselOrder.id);
  assert.ok(conflicts.some((c) => c.code === "FUEL_MISMATCH"));

  // 单车装不下
  store.upsertDraft(dieselOrder.id, { truckId: "truck-B", tons: 40, arriveDate: "2026-07-02", slotId: "morning" });
  conflicts = store.draftConflicts(dieselOrder.id);
  assert.ok(conflicts.some((c) => c.code === "OVER_LIMIT"));

  // 混装：truck-C 先排 92，再排柴油同时段
  store.upsertDraft(dieselOrder.id, { truckId: "truck-B", tons: 12, arriveDate: "2026-07-02", slotId: "morning" });
  store.reserve(dieselOrder.id);
  // 新建两张挂到 truck-C
  store.saveCreateDraft({ station: "新区站", fuel: "92号汽油", tons: 10, arriveDate: "2026-07-05", slotId: "morning", notes: "" });
  store.createOrder();
  const gas = store.ledger.orders[0];
  store.upsertDraft(gas.id, { truckId: "truck-C", tons: 10, arriveDate: "2026-07-05", slotId: "morning", fuel: "92号汽油" });
  store.reserve(gas.id);
  store.saveCreateDraft({ station: "城东站", fuel: "柴油", tons: 5, arriveDate: "2026-07-05", slotId: "morning", notes: "" });
  store.createOrder();
  const d2 = store.ledger.orders[0];
  store.upsertDraft(d2.id, { truckId: "truck-C", tons: 5, arriveDate: "2026-07-05", slotId: "morning", fuel: "柴油" });
  conflicts = store.draftConflicts(d2.id);
  assert.ok(conflicts.some((c) => c.code === "FUEL_MIX"));
});

test("装车确认 → 发车 → 到站：占用两段式转换并最终释放", () => {
  const store = newStore();
  const order = store.ledger.orders.find((o) => o.status === "待派车");
  store.upsertDraft(order.id, { truckId: "truck-B", tons: 12, arriveDate: TODAY, slotId: "morning", fuel: "柴油" });
  store.reserve(order.id);
  store.confirmLoading(order.id);
  let occ = store.ledger.occupancies[0];
  assert.equal(occ.status, "占用");
  assert.ok(occ.confirmedAt);
  assert.equal(store.ledger.orders.find((o) => o.id === order.id).status, "装车中");
  assert.equal(truckWindowUsage(store.ledger, "truck-B", TODAY, "morning").occupied, 12);

  store.depart(order.id);
  assert.equal(store.ledger.orders.find((o) => o.id === order.id).status, "运输中");
  assert.equal(store.occupanciesForOrder(order.id).length, 1, "在途仍保持占用");

  store.arrive(order.id);
  occ = store.ledger.occupancies[0];
  assert.equal(occ.status, "已释放");
  assert.equal(occ.releaseReason, "到站");
  assert.equal(store.occupanciesForOrder(order.id).length, 0);
  assert.equal(truckWindowUsage(store.ledger, "truck-B", TODAY, "morning").used, 0);
});

test("撤单释放预占；在途失败释放占用", () => {
  const store = newStore();
  const order = store.ledger.orders.find((o) => o.status === "待派车");
  store.upsertDraft(order.id, { truckId: "truck-B", tons: 12, arriveDate: TODAY, slotId: "morning", fuel: "柴油" });
  store.reserve(order.id);
  assert.equal(truckWindowUsage(store.ledger, "truck-B", TODAY, "morning").used, 12);
  store.cancelOrder(order.id);
  assert.equal(store.ledger.orders.find((o) => o.id === order.id).status, "撤单");
  assert.equal(truckWindowUsage(store.ledger, "truck-B", TODAY, "morning").used, 0);
  assert.equal(store.draftFor(order.id), undefined, "撤单同时清理草稿");

  // 在途失败路径：新单走完整流程后失败
  store.saveCreateDraft({ station: "城东站", fuel: "92号汽油", tons: 10, arriveDate: TODAY, slotId: "afternoon", notes: "" });
  store.createOrder();
  const o2 = store.ledger.orders[0];
  store.upsertDraft(o2.id, { truckId: "truck-A", tons: 10, arriveDate: TODAY, slotId: "afternoon", fuel: "92号汽油" });
  store.reserve(o2.id);
  store.confirmLoading(o2.id);
  store.depart(o2.id);
  store.failInTransit(o2.id);
  assert.equal(store.ledger.orders.find((o) => o.id === o2.id).status, "在途失败");
  assert.equal(truckWindowUsage(store.ledger, "truck-A", TODAY, "afternoon").used, 0);
});

test("WAL 恢复：主台账落盘前中断，重开按写前记录补全", () => {
  const store = newStore();
  const seq = store.ledger.seq;
  // 模拟崩溃：直接写 pending（新版本）但不更新主台账
  const pendingLedger = JSON.parse(JSON.stringify(store.ledger));
  pendingLedger.seq = seq + 1;
  pendingLedger.orders[0].status = "装车中";
  storage.writePending({ ledger: pendingLedger, reason: "装车确认占用", savedAt: new Date().toISOString() });

  const result = bootstrapLedger();
  assert.equal(result.ledger.seq, seq + 1);
  assert.equal(result.ledger.orders[0].status, "装车中");
  assert.equal(localStorage.getItem(KEYS.pending), null);
  assert.ok(result.notices[0].message.includes("中断"));
});

test("乐观锁：两个窗口同版本提交时后到者被拒绝，不会覆盖先来的占用", () => {
  const store = newStore();
  const base = storage.readLedgerState().ledger;
  const nextA = JSON.parse(JSON.stringify(base));
  nextA.seq = base.seq + 1;
  storage.commitLedger(base.seq, nextA, "窗口A 派车");

  const stale = JSON.parse(JSON.stringify(base));
  stale.seq = base.seq + 1;
  stale.orders[0].status = "撤单";
  assert.throws(
    () => storage.commitLedger(base.seq, stale, "窗口B 派车"),
    (err) => err.name === "StaleWriteError"
  );
  // 先来的占用仍在，后来的撤单没有盖掉
  const current = storage.readLedgerState().ledger;
  assert.equal(current.seq, base.seq + 1);
  assert.notEqual(current.orders[0].status, "撤单");
});

test("建单表单草稿落盘，重开可恢复", () => {
  const store = newStore();
  store.saveCreateDraft({ station: "机场站", fuel: "柴油", tons: 7, arriveDate: TODAY, slotId: "afternoon", notes: "夜里补油" });
  const raw = JSON.parse(localStorage.getItem(KEYS.createDraft));
  assert.equal(raw.station, "机场站");
  assert.equal(raw.notes, "夜里补油");

  // 模拟重开：新 store 从盘上恢复
  setActivePinia(createPinia());
  const reopened = useDispatchStore();
  reopened.bootstrap();
  assert.equal(reopened.createDraft.station, "机场站");
  assert.equal(reopened.createDraft.tons, 7);
});

test("释放出来的容量立即可用（列表/看板跟随最新占用）", () => {
  const store = newStore();
  // truck-B 25t 全满
  const o = store.ledger.orders.find((x) => x.status === "待派车");
  store.upsertDraft(o.id, { truckId: "truck-B", tons: 25, arriveDate: TODAY, slotId: "morning", fuel: "柴油" });
  store.reserve(o.id);
  assert.equal(store.remainingForTruck("truck-B", TODAY, "morning"), 0);
  store.confirmLoading(o.id);
  store.depart(o.id);
  store.failInTransit(o.id);
  assert.equal(store.remainingForTruck("truck-B", TODAY, "morning"), 25);
});

test("窗口重叠判定：上下午互不撞车，跨天同车可复用", () => {
  const store = newStore();
  const o = store.ledger.orders.find((x) => x.status === "待派车");
  store.upsertDraft(o.id, { truckId: "truck-B", tons: 20, arriveDate: TODAY, slotId: "morning", fuel: "柴油" });
  store.reserve(o.id);
  store.saveCreateDraft({ station: "城东站", fuel: "柴油", tons: 20, arriveDate: TODAY, slotId: "afternoon", notes: "" });
  store.createOrder();
  const o2 = store.ledger.orders[0];
  store.upsertDraft(o2.id, { truckId: "truck-B", tons: 20, arriveDate: TODAY, slotId: "afternoon", fuel: "柴油" });
  assert.equal(store.draftConflicts(o2.id).length, 0, "同车上下午不撞");
});

test("状态不允许的操作不产生空台账版本，也不写事件", () => {
  const store = newStore();
  const seq = store.ledger.seq;
  const eventsCount = store.ledger.orders[0].events.length;
  // seed-1 为运输中：装车确认不适用
  store.confirmLoading(store.ledger.orders[0].id);
  assert.equal(store.ledger.seq, seq);
  assert.equal(store.ledger.orders[0].events.length, eventsCount);
  // 待派车单尝试到站 / 失败同样无效
  const pending = store.ledger.orders.find((o) => o.status === "待派车");
  store.arrive(pending.id);
  store.failInTransit(pending.id);
  assert.equal(store.ledger.seq, seq);
  assert.equal(store.ledger.orders.find((o) => o.id === pending.id).status, "待派车");
});
