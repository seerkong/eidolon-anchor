import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseProviderCatalogRaw, resolveActorModelConfig } from "@cell/ai-core-logic/llm/ModelConfigRules";
import { LocalFileRuntimeSnapshotRepository } from "../src/runtime/LocalFileRuntimeSnapshotRepository";

const TOP_LEVEL_KEY = "sk-snapshot-top-level-secret";
const NESTED_AUTHORIZATION = "Bearer nested-authorization-secret";
const NESTED_TOKEN = "nested-access-token-secret";
const NESTED_CLIENT_SECRET = "nested-client-secret-value";
const HEADER_API_KEY = "header-x-api-key-secret";
const NESTED_SECRET_KEY = "nested-secret-key-value";

function makeActor() {
  return {
    version: 3,
    key: "main",
    id: "actor-main",
    type: "primary",
    systemPrompts: [],
    toolPolicy: {
      allowedToolsMode: "all",
      allowedTools: [],
      enabledToolKeys: [],
      disabledToolKeys: [],
      computedDisabledTools: [],
    },
    modelConfig: {
      provider: "openai",
      adapter: "openai",
      model: "gpt-secure",
      apiKey: TOP_LEVEL_KEY,
      baseUrl: "https://api.example.test/v1",
      inputLimit: 128_000,
      outputLimit: 16_000,
      capabilities: { modalities: { input: ["text", "image"], output: ["text"] } },
      options: {
        headers: { authorization: NESTED_AUTHORIZATION, "x-api-key": HEADER_API_KEY },
        connection: {
          token: NESTED_TOKEN,
          credentials: { client_secret: NESTED_CLIENT_SECRET, secret_key: NESTED_SECRET_KEY },
        },
      },
    },
    ctrlOptions: {
      stopAfterFirstTool: false,
      stopAfterTools: [],
      exitAfterToolResult: false,
    },
    taskTree: { rootTaskId: null, tasks: {} },
    mailboxes: {
      control: [],
      toolResult: [],
      asyncCompletion: [],
      childDone: [],
      memberCoordination: [],
      humanInput: [],
      memberChatInbox: [],
      heartbeat: [],
    },
    toolCallStreamState: { toolCalls: [] },
  } as any;
}

describe("runtime snapshot provider credential redaction", () => {
  it("recursively removes top-level and nested credentials from actor.json", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-actor-redaction-"));
    try {
      const repository = new LocalFileRuntimeSnapshotRepository(path.join(sessionDir, "runtime_state"));
      const actor = makeActor();
      await repository.writeActor(actor);

      const raw = fs.readFileSync(repository.actorPath(actor), "utf8");
      for (const secret of [
        TOP_LEVEL_KEY,
        NESTED_AUTHORIZATION,
        NESTED_TOKEN,
        NESTED_CLIENT_SECRET,
        HEADER_API_KEY,
        NESTED_SECRET_KEY,
      ]) {
        expect(raw).not.toContain(secret);
      }
      expect(raw).toContain('"provider": "openai"');
      expect(raw).toContain('"model": "gpt-secure"');
      expect(raw).toContain('"baseUrl": "https://api.example.test/v1"');
      expect(raw).toContain('"inputLimit": 128000');
      expect(raw).toContain('"modalities"');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("does not let recovered redaction placeholders override current provider credentials", () => {
    const currentApiKey = "sk-current-provider-config";
    const currentAuthorization = "Bearer current-provider-config";
    const currentToken = "current-provider-token";
    const providerConfig = parseProviderCatalogRaw({
      providers: [{
        id: "openai",
        adapter: "openai",
        options: {
          baseURL: "https://api.example.test/v1",
          apiKey: currentApiKey,
          headers: { authorization: currentAuthorization },
          connection: { token: currentToken },
        },
        models: [{ id: "gpt-secure", limits: { context: 128_000, output: 16_000 } }],
      }],
    });

    const resolved = resolveActorModelConfig({
      agentKey: "main",
      modelRef: "openai/gpt-secure",
      providerConfig,
      fallbackModelConfig: {
        provider: "openai",
        model: "gpt-secure",
        apiKey: "[REDACTED]",
        options: {
          headers: { authorization: "[REDACTED]" },
          connection: { token: "[REDACTED]" },
        },
      },
      fallbackOverrideKeys: ["apiKey", "options"],
    });

    expect(resolved.apiKey).toBe(currentApiKey);
    expect(resolved.options).toMatchObject({
      headers: { authorization: currentAuthorization },
      connection: { token: currentToken },
    });
    expect(JSON.stringify(resolved)).not.toContain("[REDACTED]");
  });
});
