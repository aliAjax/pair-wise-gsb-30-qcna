// 调度台集成测试：在 Node 中模拟 localStorage / Web Locks / crypto，
// 验证迁移、并发派车、崩溃恢复、状态流转释放。
import { build } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

mkdirSync(".test-tmp", { recursive: true });

// ---------- 浏览器环境模拟 ----------
function createStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
    _dump: () => Object.fromEntries(map),
    _clear: () => map.clear()
  };
}

let lockQueue = Promise.resolve();
function installEnv(storage) {
  globalThis.localStorage = storage;
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => `uuid-${Math.random().toString(36).slice(2, 10)}` },
    configurable: true,
    writable: true
  });
  globalThis.navigator = {
    locks: {
      // 严格串行：模拟 Web Locks 独占
      request(name, cb) {
        const run = lockQueue.then(() => cb());
        lockQueue = run.catch(() => {});
        return run;
      }
    }
  };
  globalThis.window = { addEventListener: () => {} };
}

const entry = `
export * from "${process.cwd()}/src/storage.ts";
export * from "${process.cwd()}/src/domain.ts";
export * from "${process.cwd()}/src/seed.ts";
`;
writeFileSync(".test-tmp/entry.ts", entry);

await build({
  entryPoints: [".test-tmp/entry.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: ".test-tmp/bundle.mjs",
  logLevel: "silent"
});

const mod = await import(pathToFileURL(".test-tmp/bundle.mjs").href);
const { bootstrap, commit, LEGACY_KEY, applyOp, evaluateDispatch, occupiedTons, isLive, activeAssignmentOf, uid } = mod;

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log("  ✓", msg);
  } else {
    failed += 1;
    console.error("  ✗", msg);
  }
}
async function section(name, fn) {
  console.log("\n" + name);
  await fn();
}

// ---------- 场景 1：全新环境 ----------
await section("场景1：全新环境初始化示例台账", async () => {
  const storage = createStorage();
  installEnv(storage);
  const result = bootstrap();
  assert(result.seeded, "写入了内置示例");
  assert(result.ledger.trucks.length === 3, "有 3 辆油罐车");
  assert(result.ledger.orders.length === 5, "有 5 张示例配送单");
  const result2 = bootstrap();
  assert(!result2.seeded && result2.ledger.orders.length === 5, "重开不会重复写入示例");
  const journalKeys = Object.keys(storage._dump()).filter((k) => k.includes("journal"));
  assert(journalKeys.length === 0, "正常启动后无残留日志");
});

// ---------- 场景 2：旧台账迁移只迁一次、记录不丢 ----------
await section("场景2：v1 旧数据迁移", async () => {
  const storage = createStorage();
  installEnv(storage);
  const legacy = [
    { id: "old-1", station: "城东站", fuel: "92号汽油", tons: 18, arriveAt: "2026-07-01", status: "运输中", notes: "车辆已出库", createdAt: "2026-06-30T01:00:00.000Z" },
    { id: "old-2", station: "机场站", fuel: "柴油", tons: 12, arriveAt: "2026-07-01", status: "待发车", notes: "等待装车" }
  ];
  storage.setItem(LEGACY_KEY, JSON.stringify(legacy));
  const r1 = bootstrap();
  assert(r1.migratedCount === 2, "迁移了 2 张旧单");
  assert(r1.ledger.orders.some((o) => o.id === "old-1"), "旧 id old-1 保留");
  const migrated = r1.ledger.orders.find((o) => o.id === "old-1");
  assert(migrated.status === "运输中", "旧状态 运输中 保留");
  assert(migrated.legacy?.notes === "车辆已出库", "原始记录挂在 legacy 留底");
  assert(migrated.windowStart === "2026-07-01T08:00", "旧日期映射为上午时段");
  assert(r1.ledger.trucks.length === 3, "迁移同时补入标准车队");
  assert(storage.getItem(LEGACY_KEY) !== null, "旧 key 原始数据保留未删除");

  // 再次 bootstrap：绝不能迁第二次
  const r2 = bootstrap();
  assert(r2.migratedCount === 0, "重开迁移计数为 0（只迁一次）");
  assert(r2.ledger.orders.filter((o) => o.id.startsWith("old-")).length === 2, "旧单仍是 2 张，未重复");
});

// ---------- 场景 3：写日志后崩溃 → 重开恢复 ----------
await section("场景3：写入中断后重开接着完成", async () => {
  const storage = createStorage();
  installEnv(storage);
  const r0 = bootstrap();
  const orderId = r0.ledger.orders.find((o) => o.status === "待发车" && !activeAssignmentOf(r0.ledger, o.id)).id;
  const truckId = "truck-01";

  // 手动构造"日志已写、台账未发布"的现场
  const op = {
    id: uid("op"),
    type: "reserve",
    at: new Date().toISOString(),
    payload: {
      assignmentId: "asg-crash-1",
      orderId,
      truckId,
      tons: 5,
      windowStart: r0.ledger.orders.find((o) => o.id === orderId).windowStart,
      windowEnd: r0.ledger.orders.find((o) => o.id === orderId).windowEnd,
      conflicts: [],
      conflictMessages: []
    }
  };
  storage.setItem(`hxwlfront-19-oil-dispatch-journal-v2:${op.id}`, JSON.stringify(op));

  const r1 = bootstrap();
  assert(r1.recovered.length === 1, "检测到 1 条未决日志");
  const asg = r1.ledger.assignments.find((a) => a.id === "asg-crash-1");
  assert(asg && asg.phase === "reserved", "未完成的预占已恢复为已预占");
  assert(occupiedTons(r1.ledger, truckId, op.payload.windowStart, op.payload.windowEnd) >= 5, "恢复后排车计入罐容占用");
  const leftOver = Object.keys(storage._dump()).filter((k) => k.includes("journal"));
  assert(leftOver.length === 0, "恢复后日志已清理");

  // 再重开：幂等，不重复应用
  const r2 = bootstrap();
  assert(r2.recovered.length === 0 && r2.ledger.assignments.filter((a) => a.id === "asg-crash-1").length === 1, "重开不重复恢复");
});

// ---------- 场景 4：迁移中断（日志在、闸门未置） ----------
await section("场景4：迁移中途断电", async () => {
  const legacy = [{ id: "old-x", station: "新区站", fuel: "柴油", tons: 9, arriveAt: "2026-08-01", status: "待发车", notes: "" }];

  // 先在独立存储里跑一次 bootstrap，取得标准迁移操作的载荷（不污染主存储）
  const helper = createStorage();
  const savedStorage = globalThis.localStorage;
  globalThis.localStorage = helper;
  helper.setItem(LEGACY_KEY, JSON.stringify(legacy));
  const helperResult = bootstrap();
  const migratePayload = {
    trucks: helperResult.ledger.trucks,
    orders: helperResult.ledger.orders,
    assignments: [],
    migratedAt: new Date().toISOString()
  };
  globalThis.localStorage = savedStorage;

  // 主存储：只有迁移日志，没有台账也没有闸门 —— 模拟日志写完、置闸门前崩溃
  const storage = createStorage();
  installEnv(storage);
  const migrateOp = { id: uid("op"), type: "migrate", at: new Date().toISOString(), payload: migratePayload };
  storage.setItem(`hxwlfront-19-oil-dispatch-journal-v2:${migrateOp.id}`, JSON.stringify(migrateOp));

  const r1 = bootstrap();
  assert(r1.ledger.orders.some((o) => o.id === "old-x"), "回放迁移后旧单存在");
  assert(storage.getItem("hxwlfront-19-oil-dispatch-migrated-v2") === "1", "恢复时补置了迁移闸门");
  const r2 = bootstrap();
  assert(r2.ledger.orders.filter((o) => o.id === "old-x").length === 1, "再重开不重复迁移");
});

// ---------- 场景 5：两个窗口同时派同一辆车（串行化 + 冲突） ----------
await section("场景5：并发派车——后提交者看到最新占用", async () => {
  const storage = createStorage();
  installEnv(storage);
  const r0 = bootstrap();
  // 找同一上午时段的两张待发车单（seed-order-2 是 12 吨柴油已预占 truck-03；用同窗口新单撞它）
  const baseOrder = r0.ledger.orders.find((o) => o.id === "seed-order-2");
  const newOrder1 = {
    id: "conc-1", station: "城东站", fuel: "92号汽油", tons: 20,
    arriveDate: baseOrder.arriveDate, phase: "morning",
    windowStart: baseOrder.windowStart, windowEnd: baseOrder.windowEnd,
    notes: "", status: "待发车", createdAt: new Date().toISOString()
  };
  const newOrder2 = { ...newOrder1, id: "conc-2", station: "机场站", tons: 10 };
  let ledger = await commit(() => ({ type: "createOrder", payload: { order: newOrder1 } }));
  ledger = await commit(() => ({ type: "createOrder", payload: { order: newOrder2 } }));

  // 两个并发派车都抢 truck-01（核定 25），同窗口各 20/10 吨
  const draft = (orderId, tons) => ({
    orderId, truckId: "truck-01", tons,
    windowStart: baseOrder.windowStart, windowEnd: baseOrder.windowEnd
  });
  const [a, b] = await Promise.all([
    commit(
      () => ({ type: "reserve", payload: { assignmentId: uid("asg"), ...draft("conc-1", 20) } }),
      { prepare: (l) => { const c = evaluateDispatch(l, draft("conc-1", 20)); return { conflicts: c.map((x) => x.code), conflictMessages: c.map((x) => x.message) }; } }
    ),
    commit(
      () => ({ type: "reserve", payload: { assignmentId: uid("asg"), ...draft("conc-2", 10) } }),
      { prepare: (l) => { const c = evaluateDispatch(l, draft("conc-2", 10)); return { conflicts: c.map((x) => x.code), conflictMessages: c.map((x) => x.message) }; } }
    )
  ]);
  // Promise.all 完成后两窗口都重新读到了最终台账
  const finalLedger = a.assignments.length >= b.assignments.length ? a : b;
  const live = finalLedger.assignments.filter((x) => x.orderId === "conc-1" || x.orderId === "conc-2");
  const reservedCount = live.filter((x) => x.phase === "reserved").length;
  const draftCount = live.filter((x) => x.phase === "draft").length;
  assert(reservedCount === 1, `恰好一张预占成功（实际 ${reservedCount}）`);
  assert(draftCount === 1, `另一张保留为草稿（实际 ${draftCount}）`);
  // 20 吨先成功；10 吨后到：20+10=30 > 25 → window-over 草稿；且不会把前者的占用盖掉
  const winner = live.find((x) => x.phase === "reserved");
  const loser = live.find((x) => x.phase === "draft");
  assert(winner && winner.tons === 20, "先到的 20 吨预占成功");
  assert(loser && loser.conflictCodes.includes("window-over"), "后到的 10 吨草稿带时段罐容超限冲突码");
  assert(occupiedTons(finalLedger, "truck-01", baseOrder.windowStart, baseOrder.windowEnd) === 20, "罐容占用以 20 吨为准，未被草稿盖掉");
});

// ---------- 场景 6：超罐容直接草稿 ----------
await section("场景6：超量派车保留草稿并写明冲突", async () => {
  const storage = createStorage();
  installEnv(storage);
  bootstrap();
  const l0 = JSON.parse(storage.getItem("hxwlfront-19-oil-dispatch-ledger-v2"));
  const o = l0.orders.find((x) => x.id === "seed-order-4");
  const draft = { orderId: o.id, truckId: "truck-03", tons: 16, windowStart: o.windowStart, windowEnd: o.windowEnd };
  const next = await commit(
    () => ({ type: "reserve", payload: { assignmentId: "asg-over", ...draft } }),
    { prepare: (l) => { const c = evaluateDispatch(l, draft, "asg-over"); return { conflicts: c.map((x) => x.code), conflictMessages: c.map((x) => x.message) }; } }
  );
  const asg = next.assignments.find((x) => x.id === "asg-over");
  assert(asg.phase === "draft", "16 吨派给核定 15 吨的车 → 草稿");
  assert(asg.conflictCodes.includes("capacity-over"), "带超罐容冲突码");
  assert(occupiedTons(next, "truck-03", o.windowStart, o.windowEnd) === 0, "草稿不占罐容");
});

// ---------- 场景 7：装车 → 在途 → 到站 全链路与释放 ----------
await section("场景7：确认占用、到站释放", async () => {
  const storage = createStorage();
  installEnv(storage);
  bootstrap();
  const reserved = JSON.parse(storage.getItem("hxwlfront-19-oil-dispatch-ledger-v2")).assignments.find((a) => a.id === "seed-asg-2");
  let ledger = await commit(() => ({ type: "confirmLoad", payload: { assignmentId: reserved.id } }));
  const loaded = ledger.assignments.find((a) => a.id === reserved.id);
  assert(loaded.phase === "occupied", "装车后排车转为已占用");
  assert(ledger.orders.find((o) => o.id === loaded.orderId).status === "运输中", "配送单进入运输中");
  assert(ledger.trucks.find((t) => t.id === "truck-03").status === "在途", "车辆状态变为在途");

  ledger = await commit(() => ({ type: "confirmArrival", payload: { assignmentId: loaded.id, orderId: loaded.orderId } }));
  const done = ledger.assignments.find((a) => a.id === reserved.id);
  assert(done.phase === "completed", "到站后排车完成");
  assert(!isLive(done), "完成的排车不再计入占用");
  assert(ledger.trucks.find((t) => t.id === "truck-03").status === "可用", "车辆恢复可用");
  assert(ledger.orders.find((o) => o.id === done.orderId).status === "已到站", "配送单已到站");
});

// ---------- 场景 8：撤单 / 在途失败释放 ----------
await section("场景8：撤单与在途失败释放占用", async () => {
  const storage = createStorage();
  installEnv(storage);
  bootstrap();
  // 撤掉已预占的 seed-order-2
  let ledger = await commit(() => ({ type: "cancelOrder", payload: { orderId: "seed-order-2" } }));
  assert(ledger.orders.find((o) => o.id === "seed-order-2").status === "已撤单", "撤单后状态为已撤单");
  assert(activeAssignmentOf(ledger, "seed-order-2") === undefined, "撤单后无活跃排车");
  assert(occupiedTons(ledger, "truck-03", ledger.orders.find((o) => o.id === "seed-order-2").windowStart, ledger.orders.find((o) => o.id === "seed-order-2").windowEnd) === 0, "罐容释放");

  // 在途失败：seed-asg-1 已占用
  ledger = await commit(() => ({ type: "failInTransit", payload: { orderId: "seed-order-1" } }));
  assert(ledger.orders.find((o) => o.id === "seed-order-1").status === "异常", "在途失败标记异常");
  assert(ledger.trucks.find((t) => t.id === "truck-02").status === "可用", "在途失败后车辆释放为可用");
  assert(ledger.assignments.find((a) => a.id === "seed-asg-1").phase === "released", "排车标记已释放");
});

// ---------- 场景 9：迁移来的无排车在途单可直接到站 ----------
await section("场景9：旧版运输中单据兼容到站", async () => {
  const storage = createStorage();
  installEnv(storage);
  storage.setItem(LEGACY_KEY, JSON.stringify([
    { id: "old-t", station: "城东站", fuel: "92号汽油", tons: 10, arriveAt: "2026-07-02", status: "运输中", notes: "" }
  ]));
  let ledger = bootstrap().ledger;
  ledger = await commit(() => ({ type: "confirmArrival", payload: { orderId: "old-t" } }));
  assert(ledger.orders.find((o) => o.id === "old-t").status === "已到站", "无排车的旧运输中单可直接确认到站");
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
