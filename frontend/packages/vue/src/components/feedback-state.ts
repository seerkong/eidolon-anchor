import { reactive } from "vue";

export type ToastType = "info" | "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
}

interface DialogState {
  type: "alert" | "confirm";
  message: string;
  title?: string;
  resolve: (result: boolean) => void;
}

export const feedbackState = reactive<{
  toasts: ToastItem[];
  dialog: DialogState | null;
}>({
  toasts: [],
  dialog: null,
});

let toastId = 1;

export function pushToast(message: string, type: ToastType = "info", duration = 2500) {
  const id = toastId++;
  feedbackState.toasts.push({ id, message, type, duration });
  window.setTimeout(() => removeToast(id), duration);
  return id;
}

export function removeToast(id: number) {
  const idx = feedbackState.toasts.findIndex((t) => t.id === id);
  if (idx >= 0) {
    feedbackState.toasts.splice(idx, 1);
  }
}

export function openDialog(type: "alert" | "confirm", message: string, title?: string) {
  return new Promise<boolean>((resolve) => {
    feedbackState.dialog = {
      type,
      message,
      title,
      resolve,
    };
  });
}

export function resolveDialog(result: boolean) {
  const dialog = feedbackState.dialog;
  if (!dialog) return;
  feedbackState.dialog = null;
  dialog.resolve(result);
}

export function cancelDialog() {
  resolveDialog(false);
}
