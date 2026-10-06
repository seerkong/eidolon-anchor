/**
 * Live-message admission by view scope.
 *
 * A TUI history view is either session-scoped or actor-scoped (the user can
 * switch which actor they are watching). Live `message.updated` /
 * `message.part.updated` events used to be dropped outright in actor scope,
 * which froze the view: the actor-scoped durable reader is a bounded snapshot
 * rather than a cursor, so nothing else would refresh it and the user had to
 * navigate (or reopen the session) to see new output.
 *
 * Dropping was never necessary. The live history event already carries actor
 * attribution (`MessageHistoryEvent.agentKey` / `agentActorId`), and the tool
 * path already keys by it, so the scope decision can be made per event.
 *
 * The predicate is intentionally evaluated against the CURRENT scope on every
 * event rather than captured when the view started, so switching the viewed
 * actor immediately re-targets the filter.
 */

/** Attribution available on a live message/part event, when the runtime supplies it. */
export type LiveMessageActor = {
  /** Canonical actor id (same space as `ActorRuntimeLaneData.actorId`). */
  actorId?: string
  /** Actor key, e.g. `main` or `main:code:detached`. */
  actorKey?: string
}

/** Which actor the visible history view is currently scoped to. */
export type HistoryViewScope =
  | { kind: "session" }
  | { kind: "actor"; actorId?: string; actorKey?: string }

/**
 * Whether a live event belongs in the currently viewed scope.
 *
 * - Session scope admits everything: that is the pre-existing behaviour and the
 *   session view relies on it (including messages with no attribution).
 * - Actor scope admits the viewed actor only, so another actor's output cannot
 *   leak into the view.
 * - An event carrying no attribution at all is admitted even in actor scope: it
 *   cannot be shown to be foreign work, and dropping it would reproduce the
 *   freeze this exists to prevent.
 */
export function shouldAdmitLiveMessage(
  scope: HistoryViewScope,
  event: LiveMessageActor,
): boolean {
  if (scope.kind === "session") return true
  const eventId = typeof event.actorId === "string" ? event.actorId : undefined
  const eventKey = typeof event.actorKey === "string" ? event.actorKey : undefined
  if (!eventId && !eventKey) return true
  // Compare like-for-like only: an actor id and an actor key are different
  // namespaces, so testing one against the other would reject a legitimate
  // event (the event carries a key, the scope happens to know only the id).
  if (eventId && scope.actorId) return eventId === scope.actorId
  if (eventKey && scope.actorKey) return eventKey === scope.actorKey
  // The event is attributed but in a form this scope cannot compare, and it is
  // not provably foreign work, so keep it visible rather than dropping it.
  return true
}
