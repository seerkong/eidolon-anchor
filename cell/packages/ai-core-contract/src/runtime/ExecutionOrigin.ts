export const EXECUTION_ORIGIN_SCHEMA_VERSION = 1 as const;

export type ExecutionOrigin = Readonly<
  | { source: "web"; sessionId: string; actorId: string; epoch: string; commandId: string; turnId: string; principalId: string }
  | { source: "tui" | "legacy"; sessionId: string; actorId: string; turnId?: string }
>;

export type ActorExecutionState = {
  originSchemaVersion: typeof EXECUTION_ORIGIN_SCHEMA_VERSION;
  origin?: ExecutionOrigin;
  status: "active" | "settled" | "interrupted";
  webOwned?: boolean;
  /** Retained diagnostics only; never restored as runnable mailbox/exec state. */
  quarantine?: { reason: string; originalOrigin?: unknown; mailboxes?: unknown; execState?: unknown };
};

export function decodeExecutionOrigin(value: unknown): ExecutionOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.source !== "web" && record.source !== "tui" && record.source !== "legacy") return undefined;
  const keys = record.source === "web"
    ? ["source", "sessionId", "actorId", "epoch", "commandId", "turnId", "principalId"]
    : ["source", "sessionId", "actorId", "turnId"];
  if (Object.keys(record).some((key) => !keys.includes(key))) return undefined;
  for (const key of keys) {
    if (key === "turnId" && record.source !== "web" && record[key] === undefined) continue;
    if (typeof record[key] !== "string" || !String(record[key]).trim()) return undefined;
  }
  return Object.freeze({ ...record }) as ExecutionOrigin;
}
