<script setup lang="ts">
import { useDispatchStore } from "../dispatch/store";

const store = useDispatchStore();
</script>

<template>
  <section v-if="store.notices.length" class="notices">
    <article v-for="notice in store.notices" :key="notice.id" class="notice" :class="`notice-${notice.kind}`">
      <span class="notice-icon">{{ notice.kind === "warn" ? "!" : notice.kind === "success" ? "✓" : "i" }}</span>
      <p>{{ notice.message }}</p>
      <button type="button" class="notice-close" @click="store.dismissNotice(notice.id)">×</button>
    </article>
  </section>
</template>
