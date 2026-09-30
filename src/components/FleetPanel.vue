<script setup lang="ts">
import { computed } from "vue";
import { formatWindow, isLive } from "../domain";
import { useDispatchStore } from "../store";

const store = useDispatchStore();

const views = computed(() =>
  store.trucks.map((truck) => {
    const live = store.assignments
      .filter((a) => a.truckId === truck.id && isLive(a))
      .sort((a, b) => a.windowStart.localeCompare(b.windowStart))
      .map((a) => {
        const order = store.orders.find((o) => o.id === a.orderId);
        return {
          id: a.id,
          tons: a.tons,
          station: order?.station ?? a.orderId,
          phaseLabel: a.phase === "occupied" ? "占用中" : "已预占",
          window: formatWindow(a)
        };
      });
    return { truck, live };
  })
);
</script>

<template>
  <section class="fleet-panel">
    <div class="fleet-head">
      <h2>车队罐容占用台</h2>
      <span class="fleet-tip">预占与占用均计入，跨窗口实时同步</span>
    </div>
    <div class="fleet-grid">
      <article v-for="view in views" :key="view.truck.id" class="truck-card" :class="view.truck.status">
        <header>
          <div>
            <strong>{{ view.truck.name }}</strong>
            <span class="plate">{{ view.truck.plate }}</span>
          </div>
          <span class="truck-status" :class="view.truck.status">{{ view.truck.status }}</span>
        </header>
        <p class="truck-meta">
          核定罐容 <b>{{ view.truck.capacity }} 吨</b> · 可装 {{ view.truck.fuels.join("、") }}
        </p>
        <div v-if="view.live.length === 0" class="truck-idle">当前无预占/占用排车</div>
        <ul v-else class="truck-live">
          <li v-for="item in view.live" :key="item.id">
            <span class="dot" :class="item.phaseLabel === '占用中' ? 'on' : 'pre'"></span>
            <span class="live-main">{{ item.station }} · {{ item.tons }} 吨</span>
            <span class="live-tag">{{ item.phaseLabel }}</span>
            <span class="live-time">{{ item.window }}</span>
          </li>
        </ul>
      </article>
    </div>
  </section>
</template>
