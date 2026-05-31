import { SceneStore } from "./SceneStore";
import type { SceneManifest, SceneMessage } from "./SceneTypes";

export interface ReplayTurn {
  turnIndex: number;
  userMessage: SceneMessage;
  recordedAssistant: SceneMessage | null;
}

export interface ReplayDiff {
  turnIndex: number;
  recordedText: string;
  replayedText: string;
  match: boolean;
}

export interface SceneReplayOptions {
  store: SceneStore;
}

export class SceneReplay {
  private store: SceneStore;

  constructor(options: SceneReplayOptions) {
    this.store = options.store;
  }

  async loadTurns(sessionId: string): Promise<{ manifest: SceneManifest | null; turns: ReplayTurn[] }> {
    const { manifest, messages } = await this.store.loadScene(sessionId);
    const turns: ReplayTurn[] = [];
    let idx = 0;

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== "user") continue;
      const assistant = i + 1 < messages.length && messages[i + 1].role === "assistant" ? messages[i + 1] : null;
      turns.push({ turnIndex: idx++, userMessage: messages[i], recordedAssistant: assistant });
      if (assistant) i++;
    }

    return { manifest, turns };
  }

  diff(recorded: string, replayed: string): ReplayDiff {
    return { turnIndex: 0, recordedText: recorded, replayedText: replayed, match: recorded === replayed };
  }
}
