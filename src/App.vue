<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import NoticeStack from "./components/NoticeStack.vue";
import OrderForm from "./components/OrderForm.vue";
import OrderList from "./components/OrderList.vue";
import TruckBoard from "./components/TruckBoard.vue";
import { STORAGE_KEYS } from "./dispatch/domain";
import { useDispatchStore } from "./dispatch/store";

const store = useDispatchStore();

// 建账 / WAL 恢复 / 旧数据迁移只做一次
store.bootstrap();

function onStorage(event: StorageEvent): void {
  if (event.key === STORAGE_KEYS.ledger || event.key === STORAGE_KEYS.pending) {
    // 另一个调度窗口提交了派车 / 释放：本窗口列表、看板、汇总跟随最新占用
    store.reloadFromStorage("检测到其它调度窗口的最新保存");
  }
  if (event.key === STORAGE_KEYS.drafts && event.newValue) {
    try {
      store.drafts = JSON.parse(event.newValue) as typeof store.drafts;
    } catch {
      /* 草稿损坏时保留本窗口视图 */
    }
  }
}

onMounted(() => window.addEventListener("storage", onStorage));
onBeforeUnmount(() => window.removeEventListener("storage", onStorage));
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 可恢复调度台</p>
          <h1>油品配送调度台</h1>
          <p class="subtitle">
            派车前按计划到达时段预占油罐车与罐容，装车后确认占用，撤单 / 在途失败 / 到站释放；
            写入中断自动续完，两个窗口同时派车不再互相覆盖。
          </p>
        </div>
        <div class="stack">
          <span class="tag">台账版本 #{{ store.ledger.seq }}</span>
          <span class="tag">WAL 可恢复提交</span>
          <span class="tag">乐观锁防覆盖</span>
        </div>
      </header>

      <NoticeStack />

      <section class="metrics">
        <article class="metric">
          <span>配送单总数</span>
          <strong>{{ store.metrics.total }}</strong>
        </article>
        <article class="metric">
          <span>待派车</span>
          <strong>{{ store.metrics.pending }}</strong>
        </article>
        <article class="metric">
          <span>预占 / 装车中</span>
          <strong>{{ store.metrics.reserved }}</strong>
        </article>
        <article class="metric">
          <span>运输中</span>
          <strong>{{ store.metrics.inTransit }}</strong>
        </article>
        <article class="metric metric-accent">
          <span>{{ store.boardDate }} 该时段罐容占用率</span>
          <strong>{{ store.metrics.rate }}%</strong>
          <small>{{ store.metrics.usedNow }}t / {{ store.metrics.totalCap }}t</small>
        </article>
      </section>

      <TruckBoard />

      <section class="workspace">
        <OrderForm />
        <OrderList />
      </section>
    </div>
  </main>
</template>
