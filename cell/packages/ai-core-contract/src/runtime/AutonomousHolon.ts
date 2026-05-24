export type AutonomousHolonClaimPayload = {
  taskId: string;
  memberId: string;
};

export type AutonomousHolonIdleExitPayload = {
  memberId: string;
  idleTimeoutMs: number;
};
