import type { ProviderEpochProfileId } from "@cell/ai-organ-contract";

const TAG = "eidolon-context-fact/v1\n";

export class ProviderContextFactWireProfileError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProviderContextFactWireProfileError";
  }
}

function tagged(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(TAG);
}

function contextFactNamespace(value: string): unknown {
  try {
    const parsed = JSON.parse(value.slice(TAG.length));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).namespace
      : undefined;
  } catch {
    return undefined;
  }
}

function countTagged(value: unknown): number {
  if (tagged(value)) return 1;
  if (Array.isArray(value)) return value.reduce((total, entry) => total + countTagged(entry), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.values(value as Record<string, unknown>)
    .reduce<number>((total, entry) => total + countTagged(entry), 0);
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const compareCodeUnits = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const actual = Object.keys(value as Record<string, unknown>).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validateProviderContextFactsInFinalWire(input: Readonly<{
  profileId: ProviderEpochProfileId;
  serializedBody: string;
}>): Readonly<{ factCount: number }> {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(input.serializedBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    body = parsed as Record<string, unknown>;
  } catch {
    throw new ProviderContextFactWireProfileError("provider_context_fact_wire_json_invalid");
  }
  const total = countTagged(body);
  if (total === 0) return Object.freeze({ factCount: 0 });
  const valid: string[] = [];
  if (input.profileId === "openai-responses@1") {
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const content = record.content;
      if (record.role !== "user" || !Array.isArray(content) || content.length !== 1) continue;
      const part = content[0];
      if (exactObject(part, ["type", "text"])
        && part.type === "input_text"
        && tagged(part.text)) valid.push(part.text);
    }
  } else if (input.profileId === "anthropic-chat@1") {
    for (const item of Array.isArray(body.messages) ? body.messages : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const content = record.content;
      if (record.role !== "user" || !Array.isArray(content) || content.length !== 1) continue;
      const part = content[0];
      if (exactObject(part, ["type", "text"])
        && part.type === "text"
        && tagged(part.text)) valid.push(part.text);
    }
  } else if (input.profileId === "claude-code@1") {
    for (const item of Array.isArray(body.messages) ? body.messages : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (record.role === "user" && tagged(record.content)) valid.push(record.content);
    }
  } else {
    for (const item of Array.isArray(body.messages) ? body.messages : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (record.role === "user" && tagged(record.content)) valid.push(record.content);
    }
  }
  if (valid.length !== total) {
    throw new ProviderContextFactWireProfileError("provider_context_fact_wire_profile_mismatch");
  }
  if (valid.some((fact) => contextFactNamespace(fact) === "work-context")) {
    throw new ProviderContextFactWireProfileError("provider_context_fact_namespace_not_provider_visible");
  }
  return Object.freeze({ factCount: valid.length });
}
