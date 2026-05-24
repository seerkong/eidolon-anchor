export const DELEGATE_RUN_MODES = {
  syncWait: "sync_wait",
  detached: "detached",
} as const;

export type DelegateRunMode = (typeof DELEGATE_RUN_MODES)[keyof typeof DELEGATE_RUN_MODES];

export function normalizeDelegateRunMode(mode: unknown): DelegateRunMode {
  return mode === DELEGATE_RUN_MODES.detached
    ? DELEGATE_RUN_MODES.detached
    : DELEGATE_RUN_MODES.syncWait;
}
