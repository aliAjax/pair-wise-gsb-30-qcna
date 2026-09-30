<script setup lang="ts">
import type { Order } from "../dispatch/types";
import { SLOTS, getSlot } from "../dispatch/domain";
import { useDispatchStore } from "../dispatch/store";
import { computed } from "vue";

const props = defineProps<{ order: Order }>();
const store = useDispatchStore();

const draft = computed(() => store.draftFor(props.order.id));

const liveConflicts = computed(() => store.draftConflicts(props.order.id));

const actives = computed(() => store.occupanciesForOrder(props.order.id));

const canDispatch = computed(() => props.order.status === "待派车");

function ensureDraft(): void {
  if (store.draftFor(props.order.id)) return;
  const firstUsable = store.ledger.trucks.find((t) => t.fuels.includes(props.order.fuel));
  store.upsertDraft(props.order.id, {
    truckId: firstUsable?.id ?? store.ledger.trucks[0]?.id ?? "",
    tons: props.order.tons,
    arriveDate: props.order.arriveDate,
    slotId: props.order.slotId,
    fuel: props.order.fuel,
    conflicts: []
  });
}

function openRedispatch(): void {
  // 在途失败后重新安排：以原单信息新建一张待派车配送单
  store.saveCreateDraft({
    station: props.order.station,
    fuel: props.order.fuel,
    tons: props.order.tons,
    arriveDate: props.order.arriveDate,
    slotId: props.order.slotId,
    notes: `接续在途失败单 ${props.order.id.slice(0, 8)}`
  });
  store.pushNotice("info", "已把失败单信息带入建单草稿，确认后可重新派车。");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

const slotLabel = (slotId: string) => getSlot(slotId).label;

function truckRemaining(): number {
  if (!draft.value) return 0;
  return store.remainingForTruck(
    draft.value.truckId,
    draft.value.arriveDate,
    draft.value.slotId,
    props.order.id
  );
}
</script>

<template>
  <article class="record">
    <div class="record-head">
      <p class="record-title">{{ order.station }} / {{ order.fuel }}</p>
      <div class="badges">
        <span v-if="order.migrated" class="badge badge-migrated">旧台账迁入</span>
        <span class="status" :class="`st-${order.status}`">{{ order.status }}</span>
      </div>
    </div>

    <div class="details">
      <span>配送吨数：{{ order.tons }} 吨</span>
      <span>计划到达：{{ order.arriveDate }} {{ slotLabel(order.slotId) }}</span>
      <span>单据编号：{{ order.id.slice(0, 8) }}</span>
      <span v-if="actives.length">车辆安排：{{ store.truckName(actives[0].truckId) }}</span>
    </div>

    <p class="note">{{ order.notes }}</p>

    <!-- 当前占用明细：跟随最新台账 -->
    <div v-if="actives.length" class="occ-current">
      <span v-for="occ in actives" :key="occ.id" class="occ-chip" :class="occ.status === '预占' ? 'chip-reserve' : 'chip-occupy'">
        {{ store.truckName(occ.truckId) }} · {{ occ.tons }}t · {{ occ.status }}
      </span>
    </div>

    <!-- 派车草稿：冲突或中断后重开都在这里接着完成 -->
    <div v-if="canDispatch && draft" class="draft-box">
      <p class="draft-title">调度草稿 <em>（选择车辆后按最新占用实时校验）</em></p>
      <div class="draft-grid">
        <label>
          油罐车
          <select
            :value="draft.truckId"
            @change="store.upsertDraft(order.id, { truckId: ($event.target as HTMLSelectElement).value })"
          >
            <option v-for="truck in store.ledger.trucks" :key="truck.id" :value="truck.id">
              {{ truck.name }}（同段剩 {{ store.remainingForTruck(truck.id, draft.arriveDate, draft.slotId, order.id) }}t）
            </option>
          </select>
        </label>
        <label>
          预占吨数
          <input
            type="number"
            min="0"
            step="0.5"
            :value="draft.tons"
            @input="store.upsertDraft(order.id, { tons: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label>
          到达日期
          <input
            type="date"
            :value="draft.arriveDate"
            @input="store.upsertDraft(order.id, { arriveDate: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label>
          到达时段
          <select
            :value="draft.slotId"
            @change="store.upsertDraft(order.id, { slotId: ($event.target as HTMLSelectElement).value })"
          >
            <option v-for="slot in SLOTS" :key="slot.id" :value="slot.id">{{ slot.label }}</option>
          </select>
        </label>
      </div>

      <p class="draft-remaining">
        当前选择车辆该时段剩余罐容 <strong>{{ truckRemaining() }}</strong> 吨
        （预占 + 占用合并计算）。
      </p>

      <ul v-if="liveConflicts.length" class="conflict-list">
        <li v-for="conflict in liveConflicts" :key="conflict.code" class="conflict-item">
          <strong>冲突：</strong>{{ conflict.message }}
        </li>
      </ul>

      <div class="draft-actions">
        <button type="button" @click="store.reserve(order.id)">预占车辆与罐容</button>
        <button type="button" class="secondary" @click="store.discardDraft(order.id)">放弃草稿</button>
      </div>
    </div>

    <!-- 流转操作 -->
    <div class="actions">
      <button v-if="canDispatch && !draft" type="button" @click="ensureDraft">派车预占</button>
      <button v-if="order.status === '已预占'" type="button" @click="store.confirmLoading(order.id)">装车确认占用</button>
      <button v-if="order.status === '装车中'" type="button" @click="store.depart(order.id)">发车（运输中）</button>
      <button v-if="order.status === '运输中'" type="button" @click="store.arrive(order.id)">到站签收并释放</button>
      <button v-if="order.status === '运输中'" class="danger" type="button" @click="store.failInTransit(order.id)">在途失败并释放</button>
      <button v-if="['待派车', '已预占', '装车中'].includes(order.status)" class="secondary" type="button" @click="store.cancelOrder(order.id)">撤单释放</button>
      <button v-if="order.status === '在途失败'" type="button" @click="openRedispatch">按原单重新安排</button>
    </div>

    <details class="events">
      <summary>调度记录（{{ order.events.length }}）</summary>
      <ul>
        <li v-for="(event, index) in [...order.events].reverse()" :key="index">
          <time>{{ new Date(event.at).toLocaleString("zh-CN") }}</time>
          <span>{{ event.text }}</span>
        </li>
      </ul>
    </details>
  </article>
</template>
