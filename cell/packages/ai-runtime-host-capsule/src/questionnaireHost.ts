import type { QuestionnairePublicationEffects, QuestionnaireRequestPayload, QuestionnaireRow } from "@cell/ai-core-contract"
import type { HostRequest, QuestionRecord } from "@cell/ai-runtime-host-contract"
import {
  HostProtocolFailure, prepareObservationReservation, publishObservation, recordHostQuestion, recordHostTurn,
  releaseHostQuestion, reserveHostQuestion, type CommandRuntime, type CommandLimits, type ObservationRuntime, type ObservationPublication,
} from "@cell/ai-runtime-host-logic"

export type QuestionnaireHostOptions = {
  commands: CommandRuntime
  observations: ObservationRuntime
  actorId: (identity: { id: string; key: string }) => string | undefined
  currentTurn: (actorId: string) => { turnId: string; request: HostRequest } | undefined
  limits?: CommandLimits
}

function publicQuestion(request: QuestionnaireRequestPayload, actorId: string, turnId: string): QuestionRecord {
  return {
    actorId, turnId, questionnaireId: request.questionnaireId, state: "pending", canAnswer: true,
    schema: {
      title: request.title ?? "Input required",
      questions: request.questions.map((question, index) => ({
        id: question.id,
        prompt: [index === 0 ? request.intro : undefined, question.prompt, question.helpText,
          question.type === "number" || question.type === "json" ? `Response type: ${question.type}` : undefined,
          question.required ? "Required" : undefined,
        ].filter(Boolean).join("\n"),
        ...(question.choices?.length ? { options: question.choices.map(choice => typeof choice === "string"
          ? { id: choice, label: choice } : { id: choice.value, label: choice.label ?? choice.value }) }
          : question.type === "yes_no" ? { options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } : {}),
        ...(question.type === "multi_select" ? { multiple: true } : {}),
      })),
    },
  }
}

/** Adapter projection and admission only. Questionnaire rows/mailboxes remain owned by core. */
export function createQuestionnaireHostEffects(options: QuestionnaireHostOptions): QuestionnairePublicationEffects {
  const { commands, observations } = options
  const reject = (request: HostRequest | undefined, code: string): never => {
    throw new HostProtocolFailure(403, { code, requestId: request?.requestId ?? "questionnaire", retryable: false })
  }
  const transitioned = (row: QuestionnaireRow) => {
    if (row.status === "pending" || !row.ownerActorId || !row.ownerActorKey) return
    const actorId = options.actorId({ id: row.ownerActorId, key: row.ownerActorKey })
    const existing = commands.index.questions.get(row.questionnaireId)?.record
    if (!actorId || !existing || existing.actorId !== actorId || existing.state !== "pending") return
    const record: QuestionRecord = {
      actorId, turnId: existing.turnId, questionnaireId: row.questionnaireId,
      state: row.status === "answered" ? "answered" : "cancelled", canAnswer: false,
    }
    recordHostQuestion(commands, record)
    publishObservation(observations, { kind: "question.updated", payload: record })
  }
  return {
    admit({ actor, request: payload }) {
      const actorId = options.actorId(actor)
      const owner = actorId ? options.currentTurn(actorId) : undefined
      if (!actorId || !owner) return reject(undefined, "question_owner_missing")
      const request = owner.request
      const turn = commands.index.turns.get(owner.turnId)
      const summary = commands.effects.actor(actorId)
      if (!turn || turn.principalId !== request.principal.principalId || turn.turn.actorId !== actorId) return reject(request, "question_owner_mismatch")
      if (commands.authorization.currentGrantsVersion(request.principal.principalId) !== request.principal.grantsVersion
        || !commands.authorization.permits(request.principal, { kind: "actor", sessionId: commands.sessionId, actorId, action: "answer_question" })
        || !summary?.allowedActions.includes("answer_question") || !summary.capabilities.questionnaireAnswer) return reject(request, "question_forbidden")
      const record = publicQuestion(payload, actorId, owner.turnId)
      const previousTurn = turn.turn
      const waitingTurn = { ...previousTurn, state: "waiting_input" as const, pendingQuestionIds: [...new Set([...previousTurn.pendingQuestionIds, record.questionnaireId])] }
      const publications: ObservationPublication[] = [
        { kind: "question.updated", payload: record }, { kind: "turn.updated", payload: waitingTurn },
        ...[...commands.index.entries.values()].flatMap(entry => entry.status?.turnId === owner.turnId ? [{
          kind: "command.updated" as const, principalId: entry.principalId, payload: { ...entry.status, associatedTurn: waitingTurn },
        }] : []),
      ]
      // No await may occur between this capacity check, reservation, and owner publication.
      const metadata = prepareObservationReservation(observations, { reserve: [{ kind: "answer", turnId: owner.turnId, questionnaireId: record.questionnaireId }] }, publications)
      reserveHostQuestion(commands, request, record, options.limits)
      metadata.commit()
      let released = false
      let published = false
      return {
        publish(row) {
          if (released || published) return
          if (row.ownerActorId !== actor.id || row.ownerActorKey !== actor.key || row.questionnaireId !== payload.questionnaireId || row.status !== "pending") {
            releaseHostQuestion(commands, record)
            metadata.release()
            released = true
            return reject(request, "question_owner_mismatch")
          }
          publishObservation(observations, { kind: "question.updated", payload: record })
          published = true
          publishObservation(observations, { kind: "turn.updated", payload: waitingTurn })
          recordHostTurn(commands, waitingTurn)
        },
        release() {
          if (released) return
          released = true
          metadata.release()
          releaseHostQuestion(commands, record)
          if (published) {
            publishObservation(observations, { kind: "question.updated", payload: { actorId, turnId: record.turnId, questionnaireId: record.questionnaireId, state: "cancelled", canAnswer: false } })
            publishObservation(observations, { kind: "turn.updated", payload: previousTurn })
            recordHostTurn(commands, previousTurn)
          }
        },
      }
    },
    transitioned,
  }
}
