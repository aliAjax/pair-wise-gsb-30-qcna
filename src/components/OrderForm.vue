<script setup lang="ts">
import { FUELS, SLOTS, STATIONS } from "../dispatch/domain";
import { useDispatchStore } from "../dispatch/store";

const store = useDispatchStore();
</script>

<template>
  <form class="panel" @submit.prevent="store.createOrder()">
    <h2>创建配送单</h2>
    <p v-if="store.createDraft.updatedAt" class="form-recover">
      上次表单未完成，已自动恢复草稿，可接着填写。
    </p>
    <div class="form-grid">
      <label>
        目标油站
        <select :value="store.createDraft.station" @change="store.saveCreateDraft({ station: ($event.target as HTMLSelectElement).value })" required>
          <option v-for="station in STATIONS" :key="station" :value="station">{{ station }}</option>
        </select>
      </label>
      <label>
        油品
        <select :value="store.createDraft.fuel" @change="store.saveCreateDraft({ fuel: ($event.target as HTMLSelectElement).value })" required>
          <option v-for="fuel in FUELS" :key="fuel.name" :value="fuel.name">{{ fuel.name }}</option>
        </select>
      </label>
      <label>
        配送吨数
        <input
          type="number"
          min="0"
          step="0.5"
          :value="store.createDraft.tons"
          @input="store.saveCreateDraft({ tons: Number(($event.target as HTMLInputElement).value) })"
          required
        />
      </label>
      <div class="form-row">
        <label>
          计划到达日期
          <input
            type="date"
            :value="store.createDraft.arriveDate"
            @input="store.saveCreateDraft({ arriveDate: ($event.target as HTMLInputElement).value })"
            required
          />
        </label>
        <label>
          到达时段
          <select :value="store.createDraft.slotId" @change="store.saveCreateDraft({ slotId: ($event.target as HTMLSelectElement).value })">
            <option v-for="slot in SLOTS" :key="slot.id" :value="slot.id">{{ slot.label }}</option>
          </select>
        </label>
      </div>
      <label>
        备注
        <textarea
          :value="store.createDraft.notes"
          @input="store.saveCreateDraft({ notes: ($event.target as HTMLTextAreaElement).value })"
          placeholder="填写处理说明或现场备注"
        />
      </label>
      <button type="submit">保存配送单</button>
      <p class="form-hint">保存后进入「待派车」；派车时按计划到达时段预占车辆与罐容。</p>
    </div>
  </form>
</template>
