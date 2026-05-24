import path from "node:path";

import type { ChatMessage } from "@shared/composer";

export type ActorTranscriptIdentity = {
  kind?: string;
  name?: string;
};

export type ActorTranscriptDescriptor = {
  agentKey?: string;
  actorId: string;
  actorType?: string;
  identity?: ActorTranscriptIdentity | null;
  agentName?: string;
  memberName?: string;
};

export type ActorTranscriptPaths = {
  dirName: string;
  dirPath: string;
  transcriptPath: string;
  actorPath: string;
  statePath: string;
  mailboxesPath: string;
  backupDir: string;
};

export type LoadedTranscriptMessages = {
  messages: ChatMessage[];
  source: "conversation" | "transcript" | "empty";
  path?: string;
};

function encodeSegment(value: string): string {
  const trimmed = String(value ?? "").trim();
  return encodeURIComponent(trimmed || "unknown");
}

function resolveAgentName(descriptor: ActorTranscriptDescriptor): string {
  if (descriptor.agentName) return descriptor.agentName;
  const key = String(descriptor.agentKey ?? "").trim();
  if (!key) return "agent";
  const pieces = key.split(":").filter(Boolean);
  if (pieces.length >= 2 && /^\d{10,}$/.test(pieces[pieces.length - 1] ?? "")) {
    return pieces[pieces.length - 2] ?? key;
  }
  return pieces[pieces.length - 1] ?? key;
}

export function buildActorTranscriptDirName(descriptor: ActorTranscriptDescriptor): string {
  const actorId = encodeSegment(descriptor.actorId);
  if (
    descriptor.memberName
    || descriptor.identity?.kind === "member"
  ) {
    const actorType = encodeSegment(descriptor.actorType ?? "primary");
    const memberName = encodeSegment(
      descriptor.memberName
      ?? descriptor.identity?.name
      ?? descriptor.agentKey
      ?? "member",
    );
    return `${actorType}__member__${memberName}__${actorId}`;
  }

  if ((descriptor.actorType ?? "primary") === "primary") {
    return `primary__${actorId}`;
  }

  const actorType = encodeSegment(descriptor.actorType ?? "delegate");
  const agentName = encodeSegment(resolveAgentName(descriptor));
  return `${actorType}__agent__${agentName}__${actorId}`;
}

export function getActorTranscriptPaths(sessionDir: string, descriptor: ActorTranscriptDescriptor): ActorTranscriptPaths {
  const dirName = buildActorTranscriptDirName(descriptor);
  const dirPath = path.join(sessionDir, "actors", dirName);
  return {
    dirName,
    dirPath,
    transcriptPath: path.join(dirPath, "transcript.txt"),
    actorPath: path.join(dirPath, "actor.json"),
    statePath: path.join(dirPath, "state.json"),
    mailboxesPath: path.join(dirPath, "mailboxes.json"),
    backupDir: path.join(sessionDir, "backup", "actors", dirName),
  };
}

export type ActorTranscriptStore = {
  loadMessages: (params: {
    sessionDir: string;
    actor: ActorTranscriptDescriptor;
  }) => Promise<LoadedTranscriptMessages>;
  writeMessages: (params: {
    sessionDir: string;
    actor: ActorTranscriptDescriptor;
    messages: ChatMessage[];
  }) => Promise<ActorTranscriptPaths>;
  ensureInitialized: (params: {
    sessionDir: string;
    actor: ActorTranscriptDescriptor;
    messages: ChatMessage[];
  }) => Promise<ActorTranscriptPaths>;
};
