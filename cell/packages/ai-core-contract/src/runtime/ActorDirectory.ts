import path from "node:path";

export type ActorDirIdentity = {
  kind?: string;
  name?: string;
};

export type ActorDirDescriptor = {
  agentKey?: string;
  actorId: string;
  actorType?: string;
  identity?: ActorDirIdentity | null;
  agentName?: string;
  memberName?: string;
};

export type ActorDirPaths = {
  dirName: string;
  dirPath: string;
  actorPath: string;
  statePath: string;
  mailboxesPath: string;
  backupDir: string;
};

function encodeSegment(value: string): string {
  const trimmed = String(value ?? "").trim();
  return encodeURIComponent(trimmed || "unknown");
}

function resolveAgentName(descriptor: ActorDirDescriptor): string {
  if (descriptor.agentName) return descriptor.agentName;
  const key = String(descriptor.agentKey ?? "").trim();
  if (!key) return "agent";
  const pieces = key.split(":").filter(Boolean);
  if (pieces.length >= 2 && /^\d{10,}$/.test(pieces[pieces.length - 1] ?? "")) {
    return pieces[pieces.length - 2] ?? key;
  }
  return pieces[pieces.length - 1] ?? key;
}

export function buildActorDirName(descriptor: ActorDirDescriptor): string {
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

export function getActorDirPaths(sessionDir: string, descriptor: ActorDirDescriptor): ActorDirPaths {
  const dirName = buildActorDirName(descriptor);
  const dirPath = path.join(sessionDir, "actors", dirName);
  return {
    dirName,
    dirPath,
    actorPath: path.join(dirPath, "actor.json"),
    statePath: path.join(dirPath, "state.json"),
    mailboxesPath: path.join(dirPath, "mailboxes.json"),
    backupDir: path.join(sessionDir, "backup", "actors", dirName),
  };
}
