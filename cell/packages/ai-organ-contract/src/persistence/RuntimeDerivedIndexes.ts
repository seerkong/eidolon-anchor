export type MemberRosterIndexEntry = {
  memberId: string;
  actorKey: string;
  actorId: string;
  name: string;
  role: string;
  agentType: string;
  lane: string;
  lifecycleState: string;
  waitingReason?: string | null;
  shutdownRequestId?: string | null;
  lastActiveAt?: number | null;
};

export type MemberRosterIndexSnapshot = {
  version: number;
  members: MemberRosterIndexEntry[];
  updatedAt: string;
};

export type DetachedActorsIndexEntry = {
  taskId: string;
  actorKey?: string | null;
  fiberId?: string | null;
  workloadKind: string;
  status: string;
  summary?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  error?: string | null;
  toolCallId?: string | null;
  parentFiberId?: string | null;
  childActorId?: string | null;
};

export type DetachedActorsIndexSnapshot = {
  version: number;
  tasks: DetachedActorsIndexEntry[];
  updatedAt: string;
};

export type CoordinationRecordsIndexEntry = {
  requestId: string;
  coordination: string;
  kind: string;
  actorKey?: string | null;
  status: string;
  decision?: string | null;
  updatedAt: number;
};

export type CoordinationRecordsIndexSnapshot = {
  version: number;
  records: CoordinationRecordsIndexEntry[];
  updatedAt: string;
};

export type RuntimeDerivedIndexes = {
  memberRoster: MemberRosterIndexSnapshot;
  detachedActors: DetachedActorsIndexSnapshot;
  coordinationRecords: CoordinationRecordsIndexSnapshot;
};

export type RuntimeDerivedIndexesStore = {
  load: (params: { sessionDir: string }) => Promise<RuntimeDerivedIndexes>;
  write: (params: { sessionDir: string; indexes: RuntimeDerivedIndexes }) => Promise<void>;
};
