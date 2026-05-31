import { makeUlid } from "@cell/symbiont-logic";
import { SceneStore } from "./SceneStore";
import type { SceneManifest, SceneMessage } from "./SceneTypes";

export interface SceneRecorderOptions {
  store: SceneStore;
  sessionId: string;
}

export class SceneRecorder {
  private store: SceneStore;
  private sessionId: string;

  constructor(options: SceneRecorderOptions) {
    this.store = options.store;
    this.sessionId = options.sessionId;
  }

  async startSession(manifest: SceneManifest): Promise<void> {
    await this.store.saveManifest(this.sessionId, manifest);
  }

  async recordUserMessage(text: string, id?: string): Promise<void> {
    await this.store.appendMessage(this.sessionId, {
      id: id ?? ("m_" + makeUlid()),
      role: "user",
      textParts: [text],
    });
  }

  async recordAssistantMessage(text: string, toolCalls?: SceneMessage["toolCalls"], id?: string): Promise<void> {
    await this.store.appendMessage(this.sessionId, {
      id: id ?? ("m_" + makeUlid()),
      role: "assistant",
      textParts: [text],
      toolCalls,
    });
  }
}
