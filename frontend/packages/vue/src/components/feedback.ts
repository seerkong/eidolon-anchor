import { createApp } from "vue";
import FeedbackHost from "./FeedbackHost.vue";
import { openDialog, pushToast, ToastType } from "./feedback-state";

let mounted = false;

function ensureHost() {
  if (mounted) return;
  const container = document.createElement("div");
  document.body.appendChild(container);
  createApp(FeedbackHost).mount(container);
  mounted = true;
}

export function showToast(message: string, type: ToastType = "info", duration = 2500) {
  ensureHost();
  pushToast(message, type, duration);
}

export async function alertDialog(message: string, title?: string) {
  ensureHost();
  await openDialog("alert", message, title);
}

export function confirmDialog(message: string, title?: string) {
  ensureHost();
  return openDialog("confirm", message, title);
}

export type { ToastType };
