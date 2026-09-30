<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useDispatchStore } from "./store";
import { PHASE_WINDOWS, ORDER_STATUSES, type DayPhase, type FuelType, type OrderStatus } from "./types";
import { activeAssignmentOf, isLive } from "./domain";
import DispatchEditor from "./components/DispatchEditor.vue";
import FleetPanel from "./components/FleetPanel.vue";

const store = useDispatchStore();
onMounted(() => store.init());

const stations = ["城东站", "机场站", "新区站"];
const fuels: FuelType[] = ["92号汽油", "95号汽油", "柴油"];
const phases: { value: DayPhase; label: string }[] = [
  { value: "morning", label: PHASE_WINDOWS.morning.label },
  { value: "afternoon", label: PHASE_WINDOWS.afternoon.label },
  { value: "night", label: PHASE_WINDOWS.night.label }
];

function defaultDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const form = reactive({
  station: stations[0],
  fuel: fuels[0],
  tons: 10,
  arriveDate: defaultDate(),
  phase: "morning" as DayPhase,
  notes: ""
});
const submitting = ref(false);

async function submitOrder() {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const ok = await store.createOrder({ ...form });
    if (ok) {
      form.tons = 10;
      form.notes = "";
    }
  } finally {
    submitting.value = false;
  }
}

const stationFilter = ref("全部油站");
const statusFilter = ref("全部状态");
const stationOptions = ["全部油站", ...stations];
const statusOptions = ["全部状态", ...ORDER_STATUSES];

const filteredOrders = computed(() =>
  store.orders.filter((order) => {
    const stationOk = stationFilter.value.startsWith("全部") || order.station === stationFilter.value;
    const statusOk = statusFilter.value.startsWith("全部") || order.status === statusFilter.value;
    return stationOk && statusOk;
  })
);

// 汇总跟随最新台账：预占与占用的排车吨数都计入
const metrics = computed(() => {
  const orders = store.orders;
  const reserved = store.assignments.filter((a) => a.phase === "reserved").length;
  const occupied = store.assignments.filter((a) => a.phase === "occupied").length;
  const liveTons = store.assignments.filter(isLive).reduce((sum, a) => sum + a.tons, 0);
  return [
    { label: "配送单", value: orders.length },
    { label: "待装车预占", value: reserved },
    { label: "在途（已占用）", value: occupied },
    { label: "占用/预占罐容", value: `${liveTons} 吨` }
  ];
});

const chartRows = computed(() =>
  ORDER_STATUSES.map((status) => ({
    status,
    value: store.orders.filter((order) => order.status === status).length
  }))
);
const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));

function phaseLabel(phase: DayPhase) {
  return PHASE_WINDOWS[phase].label;
}

function statusClass(status: OrderStatus) {
  return {
    待发车: "st-pending",
    运输中: "st-transit",
    已到站: "st-done",
    已撤单: "st-cancel",
    异常: "st-error"
  }[status];
}

function hasLiveAssignment(orderId: string) {
  const a = activeAssignmentOf(store.ledger, orderId);
  return !!a && isLive(a);
}

function copySummary(orderId: string) {
  const order = store.orders.find((o) => o.id === orderId);
  if (!order) return;
  const text = `${order.station} / ${order.fuel} / ${order.tons}吨 / ${order.arriveDate} ${phaseLabel(order.phase)}`;
  navigator.clipboard?.writeText(text);
  store.notify("info", "摘要已复制");
}

function confirmArrivalAction(orderId: string) {
  const assignment = activeAssignmentOf(store.ledger, orderId);
  if (assignment) store.confirmArrival(assignment.id, orderId);
  else store.confirmArrival(undefined, orderId);
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 可恢复调度台</p>
          <h1>油品配送调度台</h1>
          <p class="subtitle">
            派车先按计划到达时段预占车辆与罐容，装车后确认占用，撤单或在途失败即释放；
            写入中断重开自动续做，旧台账只迁移一次。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">原子台账 + 操作日志</span>
          <span class="tag">Web Locks 跨窗口互斥</span>
        </div>
      </header>

      <!-- 恢复 / 迁移 / 冲突等页面提示 -->
      <div v-if="store.notices.length > 0" class="notices">
        <div v-for="notice in store.notices" :key="notice.id" class="notice" :class="notice.level">
          <span>{{ notice.text }}</span>
          <button type="button" class="notice-close" @click="store.dismissNotice(notice.id)">×</button>
        </div>
      </div>

      <section class="metrics">
        <article v-for="item in metrics" :key="item.label" class="metric">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
        </article>
      </section>

      <FleetPanel />

      <p v-if="store.lastChangeAt" class="sync-hint">
        台账最近更新 {{ store.lastChangeAt }}（来源：{{ store.changeSource }}），列表与汇总已同步为最新占用
      </p>

      <section class="workspace">
        <form class="panel" @submit.prevent="submitOrder">
          <h2>创建配送单</h2>
          <div class="form-grid">
            <label>
              目标油站
              <select v-model="form.station" required>
                <option v-for="station in stations" :key="station" :value="station">{{ station }}</option>
              </select>
            </label>
            <label>
              油品
              <select v-model="form.fuel" required>
                <option v-for="fuel in fuels" :key="fuel" :value="fuel">{{ fuel }}</option>
              </select>
            </label>
            <label>
              配送吨数
              <input v-model.number="form.tons" type="number" min="0.5" step="0.5" required />
            </label>
            <label>
              计划到达日期
              <input v-model="form.arriveDate" type="date" required />
            </label>
            <label>
              到达时段
              <select v-model="form.phase">
                <option v-for="item in phases" :key="item.value" :value="item.value">
                  {{ item.label }}（{{ PHASE_WINDOWS[item.value].startHour }}:00–{{ PHASE_WINDOWS[item.value].endHour === 24 ? "24:00" : PHASE_WINDOWS[item.value].endHour + ":00" }}）
                </option>
              </select>
            </label>
            <label>
              备注
              <textarea v-model="form.notes" placeholder="填写处理说明或现场备注" />
            </label>
            <button type="submit" :disabled="submitting">{{ submitting ? "提交中…" : "保存配送单" }}</button>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>配送单调度列表</h2>
            <div class="filters">
              <select v-model="stationFilter">
                <option v-for="item in stationOptions" :key="item" :value="item">{{ item }}</option>
              </select>
              <select v-model="statusFilter">
                <option v-for="item in statusOptions" :key="item" :value="item">{{ item }}</option>
              </select>
            </div>
          </div>

          <div class="record-grid">
            <div v-if="filteredOrders.length === 0" class="empty">暂无匹配数据</div>
            <article v-for="order in filteredOrders" :key="order.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ order.station }} / {{ order.fuel }}</p>
                <span class="status" :class="statusClass(order.status)">{{ order.status }}</span>
              </div>
              <div class="details">
                <span>配送吨数：{{ order.tons }} 吨</span>
                <span>计划到达：{{ order.arriveDate }} {{ phaseLabel(order.phase) }}</span>
                <span v-if="order.legacy" class="legacy-tag">旧台账迁移单</span>
              </div>
              <p class="note">{{ order.notes }}</p>

              <!-- 待发车：嵌入可恢复的派车面板（草稿/预占/占用三态） -->
              <DispatchEditor v-if="order.status === '待发车' || order.status === '运输中'" :order="order" />

              <div class="actions">
                <template v-if="order.status === '待发车'">
                  <button type="button" class="secondary" @click="store.cancelOrder(order.id)">撤单并释放</button>
                </template>
                <template v-else-if="order.status === '运输中'">
                  <button type="button" @click="confirmArrivalAction(order.id)">确认到站</button>
                  <button type="button" class="danger" @click="store.failInTransit(order.id)">在途失败，释放占用</button>
                </template>
                <template v-else>
                  <button type="button" class="danger" :disabled="hasLiveAssignment(order.id)" @click="store.deleteOrder(order.id)">
                    删除配送单
                  </button>
                </template>
                <button type="button" class="secondary" @click="copySummary(order.id)">复制摘要</button>
              </div>
            </article>
          </div>

          <div class="mini-chart">
            <div v-for="row in chartRows" :key="row.status" class="bar">
              <span>{{ row.status }}</span>
              <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
