<script setup lang="ts">
import { SLOTS } from "../dispatch/domain";
import { useDispatchStore } from "../dispatch/store";

const store = useDispatchStore();

function percent(used: number, cap: number): number {
  return Math.min(100, Math.round((used / cap) * 100));
}
</script>

<template>
  <section class="panel board-panel">
    <div class="toolbar">
      <h2>油罐车占用台账</h2>
      <div class="slot-picker">
        <input type="date" v-model="store.boardDate" />
        <select v-model="store.boardSlotId">
          <option v-for="slot in SLOTS" :key="slot.id" :value="slot.id">{{ slot.label }}</option>
        </select>
      </div>
    </div>
    <p class="board-hint">
      按计划到达时段实时汇总：预占与占用都计入罐容，其它窗口的派车会即时反映到这里。
    </p>

    <div class="truck-grid">
      <article
        v-for="truck in store.ledger.trucks"
        :key="truck.id"
        class="truck-card"
        :class="{ 'truck-full': store.usageOf(truck.id).used >= truck.capacity }"
      >
        <div class="truck-head">
          <p class="truck-name">{{ truck.name }}</p>
          <span class="truck-fuels">{{ truck.fuels.join(" / ") }}</span>
        </div>
        <div class="capacity-line">
          <strong>{{ store.usageOf(truck.id).used }}t</strong>
          <span>/ {{ truck.capacity }}t 已安排</span>
          <em>剩 {{ Math.max(0, truck.capacity - store.usageOf(truck.id).used) }}t</em>
        </div>
        <div class="bar-track">
          <div
            class="bar-fill"
            :class="{ overload: store.usageOf(truck.id).used > truck.capacity }"
            :style="{ width: `${percent(store.usageOf(truck.id).used, truck.capacity)}%` }"
          />
        </div>
        <div class="occ-legend">
          <span class="dot dot-reserve"></span>预占 {{ store.usageOf(truck.id).reserved }}t
          <span class="dot dot-occupy"></span>占用 {{ store.usageOf(truck.id).occupied }}t
        </div>
        <ul v-if="store.usageOf(truck.id).items.length" class="occ-list">
          <li v-for="item in store.usageOf(truck.id).items" :key="item.id">
            <span class="occ-tag" :class="item.status === '预占' ? 'tag-reserve' : 'tag-occupy'">{{ item.status }}</span>
            <span class="occ-text">
              {{ item.tons }}t · {{ item.fuel }}
              <template v-if="store.orderById(item.orderId)">
                → {{ store.orderById(item.orderId)!.station }}
              </template>
              <em class="occ-order">{{ item.orderId.slice(0, 8) }}</em>
            </span>
          </li>
        </ul>
        <p v-else class="occ-empty">该时段暂无安排，可派车</p>
      </article>
    </div>
  </section>
</template>
