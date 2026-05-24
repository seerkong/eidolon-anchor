export type ToastType = "info" | "success" | "error";

type ToastItem = {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
};

type DialogState = {
  type: "alert" | "confirm";
  message: string;
  title?: string;
  resolve: (result: boolean) => void;
};

type FeedbackState = {
  toasts: ToastItem[];
  dialog: DialogState | null;
};

let state: FeedbackState = {
  toasts: [],
  dialog: null,
};

const listeners = new Set<() => void>();
let toastId = 1;

function setState(next: FeedbackState) {
  state = next;
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): FeedbackState {
  return state;
}

export function pushToast(message: string, type: ToastType = "info", duration = 2500) {
  const id = toastId++;
  const toast: ToastItem = { id, message, type, duration };
  setState({ ...state, toasts: [...state.toasts, toast] });
  window.setTimeout(() => removeToast(id), duration);
  return id;
}

export function removeToast(id: number) {
  setState({ ...state, toasts: state.toasts.filter((t) => t.id !== id) });
}

export function openDialog(type: "alert" | "confirm", message: string, title?: string) {
  return new Promise<boolean>((resolve) => {
    setState({ ...state, dialog: { type, message, title, resolve } });
  });
}

export function resolveDialog(result: boolean) {
  const dialog = state.dialog;
  if (!dialog) return;
  setState({ ...state, dialog: null });
  dialog.resolve(result);
}

export function cancelDialog() {
  resolveDialog(false);
}
