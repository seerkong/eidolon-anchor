import React from "react";
import { createRoot, Root } from "react-dom/client";
import { FeedbackHost } from "./FeedbackHost";
import { openDialog, pushToast, ToastType } from "./feedbackStore";

let root: Root | null = null;

function ensureHost() {
  if (root) return;
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(React.createElement(FeedbackHost));
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
