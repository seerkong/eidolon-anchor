import { access, mkdir, readFile, writeFile } from "node:fs/promises";

import {
  getActorTranscriptPaths,
  type ActorTranscriptStore,
  type LoadedTranscriptMessages,
} from "@cell/ai-core-contract/runtime/ActorTranscript";
import { reduceTranscriptToMessages, serializeMessagesToTranscript } from "@cell/ai-core-logic/runtime/ActorTranscript";
import { StreamTranscript } from "@cell/symbiont-logic/stream/StreamTranscript";

async function loadMessagesFromTranscriptPath(transcriptPath: string): Promise<LoadedTranscriptMessages | null> {
  try {
    await access(transcriptPath);
  } catch {
    return null;
  }

  const raw = await readFile(transcriptPath, "utf8");
  if (!raw.trim()) {
    return {
      messages: [],
      source: "transcript",
      path: transcriptPath,
    };
  }

  return {
    messages: reduceTranscriptToMessages(StreamTranscript.parse(raw).records),
    source: "transcript",
    path: transcriptPath,
  };
}

export const LocalFileActorTranscriptStore: ActorTranscriptStore = {
  async loadMessages(params) {
    const paths = getActorTranscriptPaths(params.sessionDir, params.actor);
    return (await loadMessagesFromTranscriptPath(paths.transcriptPath)) ?? {
      messages: [],
      source: "empty",
    };
  },

  async writeMessages(params) {
    const paths = getActorTranscriptPaths(params.sessionDir, params.actor);
    await mkdir(paths.dirPath, { recursive: true });
    const transcript = serializeMessagesToTranscript(params.messages);
    await writeFile(paths.transcriptPath, transcript ? `${transcript}\n` : "", "utf8");
    return paths;
  },

  async ensureInitialized(params) {
    const paths = getActorTranscriptPaths(params.sessionDir, params.actor);
    try {
      await access(paths.transcriptPath);
      return paths;
    } catch {
      // Missing transcript is expected for newly spawned actors before their first append-only write.
    }

    const hasNonSystemMessages = Array.isArray(params.messages)
      && params.messages.some((message: any) => String(message?.role ?? "") !== "" && String(message?.role ?? "") !== "system");
    if (!hasNonSystemMessages) {
      await mkdir(paths.dirPath, { recursive: true });
      await writeFile(paths.transcriptPath, "", "utf8");
      return paths;
    }

    return await LocalFileActorTranscriptStore.writeMessages(params);
  },
};
