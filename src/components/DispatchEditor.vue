<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ASSIGNMENT_PHASE_LABEL, type Assignment, type Conflict, type DeliveryOrder } from "../types";
import { activeAssignmentOf, evaluateDispatch, formatWindow } from "../domain";
import { useDispatchStore } from "../store";

const props = defineProps<{ order: DeliveryOrder }>();
const store = useDispatchStore();

const CONFLICT_TEXT: Record<string, string> = {
  "truck-repair": "车辆检修",
  "fuel-unsupported": "油品不适配",
  "capacity-over": "超罐容",
  "fuel-mix": "油品混装",
  "window-over": "时段罐容超限",
  "truck-busy": "时段撞车",
  "already-assigned": "已有生效排车",
  "tons-invalid": "吨数无效"
};

const truckId = ref("");
const tons = ref<number>(props.order.tons);
const busy = ref(false);

const activeAssignment = computed<Assignment | undefined>(() =>
  activeAssignmentOf(store.ledger, props.order.id)
);

// 已选车型/草稿切换时，预填草稿里的方案
watch(
  () => activeAssignment.value?.id,
  () => {
    const assignment = activeAssignment.value;
    if (assignment) {
      truckId.value = assignment.truckId;
      tons.value = assignment.tons;
    } else if (!truckId.value && store.trucks[0]) {
      truckId.value = store.trucks[0].id;
    }
  },
  { immediate: true }
);

watch(
  () => props.order.id,
  () => {
    tons.value = props.order.tons;
  }
);

const previewConflicts = computed<Conflict[]>(() => {
  if (!truckId.value) return [];
  return evaluateDispatch(store.ledger, {
    orderId: props.order.id,
    truckId: truckId.value,
    tons: Number(tons.value) || 0,
    windowStart: props.order.windowStart,
    windowEnd: props.order.windowEnd
  }, activeAssignment.value?.id);
});

const selectedTruck = computed(() => store.trucks.find((t) => t.id === truckId.value));

const usage = computed(() => {
  if (!truckId.value) return { used: 0, spare: 0 };
  return store.truckUsage(truckId.value, props.order.windowStart, props.order.windowEnd);
});

const draftConflicts = computed(() => activeAssignment.value?.phase === "draft" ? activeAssignment.value : undefined);

async function submitReserve() {
  if (!truckId.value || busy.value) return;
  busy.value = true;
  try {
    await store.reserve({
      orderId: props.order.id,
      truckId: truckId.value,
      tons: Number(tons.value) || 0,
      assignmentId: activeAssignment.value?.phase === "draft" ? activeAssignment.value.id : undefined
    });
  } finally {
    busy.value = false;
  }
}

async function release() {
  if (activeAssignment.value) await store.releaseAssignment(activeAssignment.value.id);
}

async function confirmLoad() {
  if (activeAssignment.value) await store.confirmLoad(activeAssignment.value.id);
}

async function removeDraft() {
  if (activeAssignment.value) await store.deleteAssignment(activeAssignment.value.id);
}
</script>

<template>
  <div class="dispatch">
    <!-- 冲突草稿：保留方案并说清原因 -->
    <div v-if="draftConflicts" class="conflict-box">
      <p class="conflict-title">⚠ 上次派车被保留为草稿，冲突未解决：</p>
      <ul>
        <li v-for="code in draftConflicts.conflictCodes ?? []" :key="code">
          {{ CONFLICT_TEXT[code] ?? code }}
        </li>
      </ul>
      <p class="conflict-hint">可在下方调整车辆或吨数后重试，冲突解决才会真正预占资源。</p>
    </div>

    <!-- 已预占：等待装车确认 -->
    <div v-else-if="activeAssignment?.phase === 'reserved'" class="phase-bar reserved">
      <div>
        <strong>{{ store.trucks.find((t) => t.id === activeAssignment.truckId)?.name }}</strong>
        <span class="phase-tag">● {{ ASSIGNMENT_PHASE_LABEL.reserved }} {{ activeAssignment.tons }} 吨</span>
        <span class="phase-time">{{ formatWindow(activeAssignment) }}</span>
      </div>
      <div class="phase-actions">
        <button type="button" @click="confirmLoad">装车完成，确认占用</button>
        <button type="button" class="secondary" @click="release">释放预占</button>
      </div>
    </div>

    <!-- 已占用（在途） -->
    <div v-else-if="activeAssignment?.phase === 'occupied'" class="phase-bar occupied">
      <div>
        <strong>{{ store.trucks.find((t) => t.id === activeAssignment.truckId)?.name }}</strong>
        <span class="phase-tag">● {{ ASSIGNMENT_PHASE_LABEL.occupied }} {{ activeAssignment.tons }} 吨</span>
        <span class="phase-time">{{ formatWindow(activeAssignment) }}</span>
      </div>
    </div>

    <template v-if="order.status === '待发车' && (!activeAssignment || activeAssignment.phase === 'draft')">
      <div class="dispatch-form">
        <label>
          油罐车
          <select v-model="truckId">
            <option value="" disabled>请选择车辆</option>
            <option v-for="truck in store.trucks" :key="truck.id" :value="truck.id">
              {{ truck.name }}（{{ truck.plate }}）· 罐容 {{ truck.capacity }} 吨 · {{ truck.status }}
            </option>
          </select>
        </label>
        <label class="tons-label">
          预占吨数
          <input v-model.number="tons" type="number" min="0.5" step="0.5" />
        </label>
      </div>

      <div v-if="selectedTruck" class="capacity-line" :class="{ tight: previewConflicts.length > 0 }">
        <span>{{ selectedTruck.name }} 该时段：核定 {{ selectedTruck.capacity }} 吨 / 已排 {{ usage.used }} 吨 / 尚可装 {{ usage.spare }} 吨</span>
      </div>

      <ul v-if="previewConflicts.length > 0" class="preview-conflicts">
        <li v-for="conflict in previewConflicts" :key="conflict.code">{{ conflict.message }}</li>
      </ul>

      <div class="dispatch-actions">
        <button type="button" :disabled="!truckId || busy" @click="submitReserve">
          {{ busy ? "提交中…" : "按到达时段预占车辆/罐容" }}
        </button>
        <button v-if="activeAssignment?.phase === 'draft'" type="button" class="danger" @click="removeDraft">放弃草稿</button>
      </div>
    </template>
  </div>
</template>
