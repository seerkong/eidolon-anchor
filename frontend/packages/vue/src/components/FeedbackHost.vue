<template>
  <div class="feedback-host">
    <div class="toast-stack" v-if="state.toasts.length">
      <div v-for="toast in state.toasts" :key="toast.id" class="toast" :data-type="toast.type">
        {{ toast.message }}
      </div>
    </div>
    <div v-if="state.dialog" class="dialog-backdrop">
      <div class="dialog">
        <div class="dialog-title">{{ state.dialog.title || defaultTitle }}</div>
        <div class="dialog-message">{{ state.dialog.message }}</div>
        <div class="dialog-actions">
          <button type="button" @click="confirm">确定</button>
          <button v-if="state.dialog.type === 'confirm'" type="button" class="ghost" @click="cancel">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { cancelDialog, feedbackState, resolveDialog } from "./feedback-state";

const state = feedbackState;
const defaultTitle = computed(() => (state.dialog?.type === "alert" ? "提示" : "确认"));

function confirm() {
  resolveDialog(true);
}

function cancel() {
  cancelDialog();
}
</script>

<style scoped>
.feedback-host {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9999;
  font-size: 14px;
}

.toast-stack {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}

.toast {
  pointer-events: auto;
  background: color-mix(in srgb, var(--bg) 70%, var(--border) 30%);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  min-width: 200px;
  text-align: center;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}

.toast[data-type="success"] {
  border-color: #2fa36b;
  color: #0f5132;
  background: #e9f7ef;
}

.toast[data-type="error"] {
  border-color: #d94848;
  color: #611818;
  background: #fdecea;
}

.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: grid;
  place-items: center;
  pointer-events: auto;
}

.dialog {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  width: min(420px, 90vw);
  box-shadow: 0 16px 32px rgba(0, 0, 0, 0.25);
  color: var(--text);
}

.dialog-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.dialog-message {
  line-height: 1.5;
  margin-bottom: 12px;
  white-space: pre-wrap;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.dialog .ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
}
</style>
