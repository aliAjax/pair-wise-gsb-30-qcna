<script setup lang="ts">
import { CHART_STATUSES, STATIONS } from "../dispatch/domain";
import { useDispatchStore } from "../dispatch/store";
import OrderCard from "./OrderCard.vue";
import { computed } from "vue";

const store = useDispatchStore();

const filters = ["全部油站", ...STATIONS];
const statusFilters = ["全部状态", ...CHART_STATUSES];

const chartRows = computed(() =>
  CHART_STATUSES.map((status) => ({
    status,
    value: store.ledger.orders.filter((order) => order.status === status).length
  }))
);
const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));
</script>

<template>
  <section class="list-panel">
    <div class="toolbar">
      <h2>配送单列表</h2>
      <div class="filters">
        <select v-model="store.stationFilter">
          <option v-for="item in filters" :key="item" :value="item">{{ item }}</option>
        </select>
        <select v-model="store.statusFilter">
          <option v-for="item in statusFilters" :key="item" :value="item">{{ item }}</option>
        </select>
      </div>
    </div>

    <p v-if="store.draftCount" class="draft-banner">
      有 {{ store.draftCount }} 张配送单的派车草稿未完成（冲突或中断保留），在下方单据中可直接继续。
    </p>

    <div class="record-grid">
      <div v-if="store.filteredOrders.length === 0" class="empty">暂无匹配数据</div>
      <OrderCard v-for="order in store.filteredOrders" :key="order.id" :order="order" />
    </div>

    <div class="mini-chart">
      <div v-for="row in chartRows" :key="row.status" class="bar">
        <span>{{ row.status }}</span>
        <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
        <strong>{{ row.value }}</strong>
      </div>
    </div>
  </section>
</template>
