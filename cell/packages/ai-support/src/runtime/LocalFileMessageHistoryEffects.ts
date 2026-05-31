import fs from "fs";
import path from "path";

import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION } from "@cell/ai-organ-contract";
import { StreamTranscript } from "@cell/symbiont-logic/stream/StreamTranscript";
import type {
  MessageHistoryAppendEvent,
  MessageHistoryBackupParams,
  MessageHistoryEffects,
  RuntimeHistorySupportParams,
} from "@cell/ai-core-contract/runtime/HistoryEffects";
import {
  getActorTranscriptPaths,
  reduceTranscriptToMessages,
} from "@cell/ai-core-logic/runtime/ActorTranscript";
import {
  chatMessagesToCommittedHistoryRefs,
  committedHistoryRefsToTranscriptRecords,
} from "../conversation/local/LocalConversationRuntime";
import {
  getLocalConversationPaths,
  getLocalHistoryGenerationPath,
} from "../conversation/local/LocalConversationPaths";

export class LocalFileMessageHistoryEffects implements MessageHistoryEffects {
  private readonly sessionPathProvider: RuntimeHistorySupportParams["sessionPathProvider"];
  private readonly log?: RuntimeHistorySupportParams["log"];

  constructor(params: RuntimeHistorySupportParams) {
    this.sessionPathProvider = params.sessionPathProvider;
    this.log = params.log;
  }

  private resolveSessionPath(): string {
    const sessionPath = this.sessionPathProvider();
    if (!sessionPath) {
      throw new Error("Message history session path is not available");
    }
    return sessionPath;
  }

  private resolveFilePath(params: MessageHistoryBackupParams): string {
    const sessionPath = this.resolveSessionPath();
    return getActorTranscriptPaths(sessionPath, {
      agentKey: params.agentKey,
      actorId: params.agentActorId,
      actorType: params.actorType as any,
      agentName: params.agentName,
      memberName: params.memberName,
    }).transcriptPath;
  }

  appendMessage(event: MessageHistoryAppendEvent): void {
    const sessionPath = this.resolveSessionPath();
    const filePath = this.resolveFilePath(event);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const exists = fs.existsSync(filePath);
    const serialized = StreamTranscript.serialize([{ stream: event.stream, payload: event.payload }], {
      delimiter: "----",
      includeHeader: !exists,
      ensureMarker: true,
      markerGenerator: generateMarker,
    });

    fs.appendFileSync(filePath, `${exists ? "\n" : ""}${serialized}`, "utf-8");
    if (event.persistConversationHistory !== false) {
      this.appendConversationHistory(sessionPath, filePath, event);
    }
  }

  async backupHistory(params: MessageHistoryBackupParams): Promise<void> {
    const filePath = this.resolveFilePath(params);
    if (!fs.existsSync(filePath)) {
      return;
    }

    try {
      const sessionPath = this.resolveSessionPath();
      const backupDir = getActorTranscriptPaths(sessionPath, {
        agentKey: params.agentKey,
        actorId: params.agentActorId,
        actorType: params.actorType as any,
        agentName: params.agentName,
        memberName: params.memberName,
      }).backupDir;
      fs.mkdirSync(backupDir, { recursive: true });

      const ext = path.extname(filePath);
      const timestamp = formatTimestamp(new Date());
      const backupFileName = `transcript_${timestamp}${ext || ".txt"}`;
      const backupFilePath = path.join(backupDir, backupFileName);

      fs.renameSync(filePath, backupFilePath);
      fs.writeFileSync(filePath, "", "utf-8");
    } catch (error) {
      this.log?.("warn", "message history backup failed", {
        file_path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private appendConversationHistory(
    sessionPath: string,
    transcriptPath: string,
    event: MessageHistoryAppendEvent,
  ): void {
    const sessionId = path.basename(sessionPath);
    const actorKey = event.agentKey;
    const actorId = event.agentActorId;
    const nowIso = new Date().toISOString();
    const paths = getLocalConversationPaths(sessionPath);

    const historyIndex = readJsonBestEffort(paths.historyIndexPath, {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      heads: {},
      lineages: {},
      generations: {},
      updatedAt: new Date(0).toISOString(),
    });
    const sessionIndex = readJsonBestEffort(paths.sessionIndexPath, {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      session: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId,
        activeActorKey: null,
        actorBindings: {},
        contextAssetRegistry: null,
        contextAssets: [],
        activeSelection: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      lineage: null,
      updatedAt: nowIso,
    });
    const generationId =
      sessionIndex.session.actorBindings[actorKey]?.historyHeadGenerationId
      ?? historyIndex.heads[actorKey]?.activeGenerationId
      ?? `${actorKey}__active`;

    const generationPath = getLocalHistoryGenerationPath(sessionPath, generationId);
    const generation = readJsonBestEffort(generationPath, {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      generationId,
      sessionId,
      actorKey,
      actorId,
      parentGenerationId: null,
      predecessorGenerationIds: [],
      createdReason: "append",
      sealed: false,
      messageCount: 0,
      messages: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    generation.actorId = actorId;
    generation.messages = chatMessagesToCommittedHistoryRefs({
      messages: reduceTranscriptToMessages([
        ...committedHistoryRefsToTranscriptRecords(generation.messages),
        {
          stream: event.stream,
          payload: event.payload,
          startAt: event.startAt,
          endAt: event.endAt,
        },
      ]),
      actorKey,
      actorId,
      recordIdPrefix: generationId,
      transcriptPath,
    });
    generation.messageCount = generation.messages.length;
    generation.updatedAt = nowIso;

    historyIndex.heads[actorKey] = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      actorKey,
      actorId,
      activeGenerationId: generationId,
      visibleGenerationIds: Array.from(new Set([
        ...(historyIndex.heads[actorKey]?.visibleGenerationIds ?? []),
        generationId,
      ])),
      updatedAt: nowIso,
    };
    historyIndex.lineages[generationId] = historyIndex.lineages[generationId] ?? {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      actorKey,
      actorId,
      generationId,
      parentGenerationId: null,
      rolledBackFromGenerationId: null,
      predecessorGenerationIds: [],
      successorGenerationIds: [],
      forkGenerationIds: [],
      branchLabel: null,
      updatedAt: nowIso,
    };
    historyIndex.generations[generationId] = {
      generationId,
      actorKey,
      actorId,
      sealed: false,
      createdAt: generation.createdAt,
      updatedAt: nowIso,
    };
    historyIndex.updatedAt = nowIso;

    sessionIndex.session.activeActorKey = actorKey;
    sessionIndex.session.actorBindings[actorKey] = {
      actorKey,
      actorId,
      boundAt: nowIso,
      historyHeadGenerationId: generationId,
      promptHeadGenerationId:
        sessionIndex.session.actorBindings[actorKey]?.promptHeadGenerationId ?? null,
    };
    sessionIndex.session.activeSelection = {
      sessionId,
      activeActorKey: actorKey,
      historyHeadGenerationId: generationId,
      promptHeadGenerationId:
        sessionIndex.session.actorBindings[actorKey]?.promptHeadGenerationId ?? null,
      selectedAt: nowIso,
    };
    sessionIndex.session.updatedAt = nowIso;
    sessionIndex.updatedAt = nowIso;

    writeJsonSync(paths.historyIndexPath, historyIndex);
    writeJsonSync(generationPath, generation);
    writeJsonSync(paths.sessionIndexPath, sessionIndex);
  }
}

export function createLocalFileMessageHistoryEffects(
  params: RuntimeHistorySupportParams,
): MessageHistoryEffects {
  const effects = new LocalFileMessageHistoryEffects(params);
  return {
    appendMessage: (event) => effects.appendMessage(event),
    backupHistory: (backupParams) => effects.backupHistory(backupParams),
  };
}

function generateMarker(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readJsonBestEffort<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonSync(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  const second = `${date.getSeconds()}`.padStart(2, "0");
  return `${year}${month}${day}_${hour}${minute}${second}`;
}
