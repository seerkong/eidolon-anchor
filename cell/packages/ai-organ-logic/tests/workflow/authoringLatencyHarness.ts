export type WorkflowAuthoringStage = "coding" | "testing" | "releasing"

export type WorkflowAuthoringTransition = {
  tool: string
  operation: string
  target?: string
  proof?: string
  workspaceMutation?: boolean
  publication?: boolean
}

export type WorkflowAuthoringTurnTiming = {
  completion: number
  stage: WorkflowAuthoringStage
  providerWaitMs: number
  generationMs: number
  toolWallMs: number
  reasoningDeltaCount?: number
  reasoningCharacterCount?: number
  transitions: WorkflowAuthoringTransition[]
}

export type WorkflowAuthoringLatencySample = {
  schemaVersion: number
  incidentId: string
  measurement: {
    boundary: string
    startedAtEpochMs: number
    publishedAtEpochMs: number
    totalMs: number
    outerDispatchMs: number
    postPublicationReportExcluded: boolean
  }
  milestones: Array<{
    kind: string
    elapsedMs: number
    completion?: number
    path?: string
  }>
  turns: WorkflowAuthoringTurnTiming[]
  outcomes: {
    toolFailureCount: number
    retryCount: number
    workspaceMutationCount: number
    authoringToolTransitionCount: number
  }
}

export type WorkflowAuthoringPhaseTiming = {
  stage: WorkflowAuthoringStage
  completionCount: number
  transitionCount: number
  providerWaitMs: number
  generationMs: number
  toolWallMs: number
  measuredMs: number
}

export function summarizeWorkflowAuthoringLatency(sample: WorkflowAuthoringLatencySample) {
  const [firstTurn, ...remainingTurns] = sample.turns
  if (!firstTurn) {
    throw new Error("workflow authoring latency samples require at least one completion")
  }
  const stages: WorkflowAuthoringStage[] = ["coding", "testing", "releasing"]
  const phases: WorkflowAuthoringPhaseTiming[] = stages.map((stage) => {
    const turns = sample.turns.filter((turn) => turn.stage === stage)
    const providerWaitMs = sum(turns.map((turn) => turn.providerWaitMs))
    const generationMs = sum(turns.map((turn) => turn.generationMs))
    const toolWallMs = sum(turns.map((turn) => turn.toolWallMs))
    return {
      stage,
      completionCount: turns.length,
      transitionCount: sum(turns.map((turn) => turn.transitions.length)),
      providerWaitMs,
      generationMs,
      toolWallMs,
      measuredMs: providerWaitMs + generationMs + toolWallMs,
    }
  })

  const providerWaitMs = sum(phases.map((phase) => phase.providerWaitMs))
  const generationMs = sum(phases.map((phase) => phase.generationMs))
  const toolWallMs = sum(phases.map((phase) => phase.toolWallMs))
  const authoringActorMs = providerWaitMs + generationMs + toolWallMs
  const firstMutationTurn = sample.turns.find((turn) => turn.transitions.some((transition) => transition.workspaceMutation))
  const firstMutationMilestone = sample.milestones.find((milestone) => milestone.kind === "first_workspace_mutation")
  const publicationMilestone = sample.milestones.find((milestone) => milestone.kind === "publication_recorded")
  const slowestGeneration = remainingTurns.reduce(
    (slowest, turn) => turn.generationMs > slowest.generationMs ? turn : slowest,
    firstTurn,
  )

  return {
    incidentId: sample.incidentId,
    boundary: sample.measurement.boundary,
    completionCount: sample.turns.length,
    transitionCount: sum(sample.turns.map((turn) => turn.transitions.length)),
    providerWaitMs,
    generationMs,
    toolWallMs,
    authoringActorMs,
    outerDispatchMs: sample.measurement.outerDispatchMs,
    totalMs: sample.measurement.totalMs,
    phases,
    firstMutation: firstMutationMilestone && firstMutationTurn
      ? { elapsedMs: firstMutationMilestone.elapsedMs, completion: firstMutationTurn.completion }
      : undefined,
    publication: publicationMilestone
      ? { elapsedMs: publicationMilestone.elapsedMs, completion: publicationMilestone.completion }
      : undefined,
    slowestGeneration,
  }
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}
