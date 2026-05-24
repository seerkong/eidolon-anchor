import { mkdir, readdir } from "node:fs/promises";

import type {
  ActorHistoryGenerationData,
  ActorPromptGenerationData,
  ConversationArtifactRefsSnapshot,
  ConversationHistoryIndexSnapshot,
  ConversationPersistenceRepository,
  ConversationPersistenceRepositoryFactory,
  ConversationPromptIndexSnapshot,
  ConversationSessionIndexSnapshot,
} from "@cell/ai-organ-contract";
import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION } from "@cell/ai-organ-contract";
import {
  getLocalConversationPaths,
  getLocalHistoryGenerationPath,
  getLocalPromptGenerationPath,
} from "./LocalConversationPaths";
import { readJsonBestEffort, writeJsonAtomically } from "./LocalConversationJson";

function zeroIso(): string {
  return new Date(0).toISOString();
}

function decodeFileStem(fileName: string): string {
  const stem = fileName.endsWith(".json") ? fileName.slice(0, -5) : fileName;
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
}

function createDefaultHistoryIndex(sessionId: string): ConversationHistoryIndexSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    heads: {},
    lineages: {},
    generations: {},
    updatedAt: zeroIso(),
  };
}

function createDefaultPromptIndex(sessionId: string): ConversationPromptIndexSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    heads: {},
    generations: {},
    updatedAt: zeroIso(),
  };
}

function createDefaultSessionIndex(sessionId: string): ConversationSessionIndexSnapshot {
  return {
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
      createdAt: zeroIso(),
      updatedAt: zeroIso(),
    },
    lineage: null,
    updatedAt: zeroIso(),
  };
}

function createDefaultArtifactRefs(sessionId: string): ConversationArtifactRefsSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    refs: [],
    updatedAt: zeroIso(),
  };
}

async function listJsonFileIds(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => decodeFileStem(entry.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export class LocalFileConversationPersistenceRepository implements ConversationPersistenceRepository {
  readonly sessionDir: string;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
  }

  async loadHistoryIndex(): Promise<ConversationHistoryIndexSnapshot> {
    const paths = getLocalConversationPaths(this.sessionDir);
    return await readJsonBestEffort(paths.historyIndexPath, createDefaultHistoryIndex(this.sessionDir));
  }

  async writeHistoryIndex(index: ConversationHistoryIndexSnapshot): Promise<void> {
    const paths = getLocalConversationPaths(this.sessionDir);
    await writeJsonAtomically(paths.historyIndexPath, index);
  }

  async loadHistoryGeneration(generationId: string): Promise<ActorHistoryGenerationData | null> {
    const filePath = getLocalHistoryGenerationPath(this.sessionDir, generationId);
    return await readJsonBestEffort<ActorHistoryGenerationData | null>(filePath, null);
  }

  async writeHistoryGeneration(generation: ActorHistoryGenerationData): Promise<void> {
    const paths = getLocalConversationPaths(this.sessionDir);
    await mkdir(paths.historyGenerationsDir, { recursive: true });
    await writeJsonAtomically(
      getLocalHistoryGenerationPath(this.sessionDir, generation.generationId),
      generation,
    );
  }

  async listHistoryGenerationIds(): Promise<string[]> {
    const paths = getLocalConversationPaths(this.sessionDir);
    return await listJsonFileIds(paths.historyGenerationsDir);
  }

  async loadPromptIndex(): Promise<ConversationPromptIndexSnapshot> {
    const paths = getLocalConversationPaths(this.sessionDir);
    return await readJsonBestEffort(paths.promptIndexPath, createDefaultPromptIndex(this.sessionDir));
  }

  async writePromptIndex(index: ConversationPromptIndexSnapshot): Promise<void> {
    const paths = getLocalConversationPaths(this.sessionDir);
    await writeJsonAtomically(paths.promptIndexPath, index);
  }

  async loadPromptGeneration(promptGenerationId: string): Promise<ActorPromptGenerationData | null> {
    const filePath = getLocalPromptGenerationPath(this.sessionDir, promptGenerationId);
    return await readJsonBestEffort<ActorPromptGenerationData | null>(filePath, null);
  }

  async writePromptGeneration(generation: ActorPromptGenerationData): Promise<void> {
    const paths = getLocalConversationPaths(this.sessionDir);
    await mkdir(paths.promptGenerationsDir, { recursive: true });
    await writeJsonAtomically(
      getLocalPromptGenerationPath(this.sessionDir, generation.promptGenerationId),
      generation,
    );
  }

  async listPromptGenerationIds(): Promise<string[]> {
    const paths = getLocalConversationPaths(this.sessionDir);
    return await listJsonFileIds(paths.promptGenerationsDir);
  }

  async loadSessionIndex(): Promise<ConversationSessionIndexSnapshot> {
    const paths = getLocalConversationPaths(this.sessionDir);
    return await readJsonBestEffort(paths.sessionIndexPath, createDefaultSessionIndex(this.sessionDir));
  }

  async writeSessionIndex(index: ConversationSessionIndexSnapshot): Promise<void> {
    const paths = getLocalConversationPaths(this.sessionDir);
    await writeJsonAtomically(paths.sessionIndexPath, index);
  }

  async loadArtifactRefs(): Promise<ConversationArtifactRefsSnapshot> {
    const paths = getLocalConversationPaths(this.sessionDir);
    return await readJsonBestEffort(paths.artifactRefsPath, createDefaultArtifactRefs(this.sessionDir));
  }

  async writeArtifactRefs(snapshot: ConversationArtifactRefsSnapshot): Promise<void> {
    const paths = getLocalConversationPaths(this.sessionDir);
    await writeJsonAtomically(paths.artifactRefsPath, snapshot);
  }
}

export const LocalFileConversationPersistenceRepositoryFactory: ConversationPersistenceRepositoryFactory = {
  createRepository(sessionDir: string) {
    return new LocalFileConversationPersistenceRepository(sessionDir);
  },
};
