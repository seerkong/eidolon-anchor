import React, { useSyncExternalStore } from "react";
import { cancelDialog, getSnapshot, resolveDialog, subscribe, ToastType } from "./feedbackStore";

const toastStyles: Record<ToastType, React.CSSProperties> = {
  info: {
    borderColor: "var(--border)",
    color: "var(--text)",
    background: "color-mix(in srgb, var(--bg) 70%, var(--border) 30%)",
  },
  success: {
    borderColor: "#2fa36b",
    color: "#0f5132",
    background: "#e9f7ef",
  },
  error: {
    borderColor: "#d94848",
    color: "#611818",
    background: "#fdecea",
  },
};

export function FeedbackHost() {
  const state = useSyncExternalStore(subscribe, getSnapshot);

  return (
    <div style={hostStyle}>
      {state.toasts.length ? (
        <div style={toastStackStyle}>
          {state.toasts.map((toast) => (
            <div key={toast.id} style={{ ...toastStyle, ...toastStyles[toast.type] }}>
              {toast.message}
            </div>
          ))}
        </div>
      ) : null}

      {state.dialog ? (
        <div style={dialogBackdropStyle}>
          <div style={dialogStyle}>
            <div style={dialogTitleStyle}>{state.dialog.title || (state.dialog.type === "alert" ? "提示" : "确认")}</div>
            <div style={dialogMessageStyle}>{state.dialog.message}</div>
            <div style={dialogActionsStyle}>
              <button type="button" onClick={() => resolveDialog(true)}>
                确定
              </button>
              {state.dialog.type === "confirm" ? (
                <button type="button" onClick={() => cancelDialog()} style={ghostButtonStyle}>
                  取消
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const hostStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  pointerEvents: "none",
  zIndex: 9999,
  fontSize: 14,
};

const toastStackStyle: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: 24,
  transform: "translateX(-50%)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  alignItems: "center",
};

const toastStyle: React.CSSProperties = {
  pointerEvents: "auto",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "10px 14px",
  minWidth: 200,
  textAlign: "center",
  boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
};

const dialogBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "grid",
  placeItems: "center",
  pointerEvents: "auto",
};

const dialogStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 16,
  width: "min(420px, 90vw)",
  boxShadow: "0 16px 32px rgba(0,0,0,0.25)",
  color: "var(--text)",
};

const dialogTitleStyle: React.CSSProperties = {
  fontWeight: 600,
  marginBottom: 8,
};

const dialogMessageStyle: React.CSSProperties = {
  lineHeight: 1.5,
  marginBottom: 12,
  whiteSpace: "pre-wrap",
};

const dialogActionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};

const ghostButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  color: "var(--text)",
};
