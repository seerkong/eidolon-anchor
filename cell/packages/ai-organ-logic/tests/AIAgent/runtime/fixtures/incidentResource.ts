/**
 * MINIMIZED / SANITIZED INCIDENT CONFORMANCE RESOURCE
 * ===================================================
 * Track `complete-runtime-evolution-migration`, P3 / requirement
 * `incident-acceptance-harness` (delta case `incident-recovers-and-continues`).
 *
 * This module is the W4 closeout incident *conformance resource*. It reproduces
 * the SHAPE of the real production incident — an old-format session that needs an
 * upgrade AND the 005 root-cause condition (a completed tool effect whose result
 * lives only in the link-only effect-evidence journal, never paired into the
 * Conversation Domain) — using ENTIRELY SYNTHETIC, SANITIZED values.
 *
 * D1 (decisions.md #1) — PRIVACY-SAFE, NO RAW REAL SESSION DATA
 * ------------------------------------------------------------
 * There is intentionally NO raw real session content here. Every field below is
 * a hand-authored synthetic constant:
 *   - the file the tool reads is a made-up path with a synthetic body;
 *   - the user prompt / assistant reply are generic placeholder strings;
 *   - the session id is a fixed synthetic literal.
 * The real `.eidolon/sessions/<id>` directories on disk (transcript.txt +
 * history-generations/*.json) are gitignored and are NOT copied in — only their
 * *structural shape* is reproduced. This satisfies the deliverable's intent
 * ("reproduce the real-incident shape") without committing potentially sensitive
 * real user session content, consistent with the backplane track's minimized 005
 * fixture precedent.
 *
 * THE INCIDENT SHAPE THIS RESOURCE ENCODES
 * ----------------------------------------
 * 1. OLD-FORMAT (needs upgrade): the persisted session predates the owned
 *    checkpoint / XNL migration — it must go through dry-run/apply upgrade before
 *    recovery (the `runtime-control` checkpoint is rewritten + applied by the
 *    harness, mirroring P2's upgrade-clean discipline).
 * 2. 005 ROOT CAUSE (interrupted turn): the model had already issued a
 *    `read_file` tool call when the turn was interrupted. The tool effect
 *    COMPLETED, but its result landed only as LINK-ONLY effect evidence (carrying
 *    the tool_call_id link, NOT the output text) and the single-owner output text
 *    lives in the ToolCallDomain record — it was never paired into the
 *    Conversation Domain / formal committed history. A pre-fix recovery would
 *    leave the next-turn provider context missing the paired result, so the model
 *    would re-issue the SAME read (the "重复读文件" symptom).
 */

/** The synthetic file the interrupted tool call reads — NOT a real path. */
export const INCIDENT_READ_FILE_PATH = "src/incident/INCIDENT_CONFORMANCE.ts";

/** The synthetic single-owner output text — NOT real session content. */
export const INCIDENT_READ_FILE_OUTPUT =
  "FILE-BODY: synthetic incident-conformance file contents, read exactly once";

/** Synthetic, fixed session id used by the conformance harness. */
export const INCIDENT_SESSION_ID = "incident-conformance-recovers-and-continues";

/** The synthetic tool-call id of the interrupted read. */
export const INCIDENT_TOOL_CALL_ID = "call_incident_conformance_read";

/** Generic placeholder conversation turn (no real user content). */
export const INCIDENT_USER_PROMPT = "read the incident conformance file";
export const INCIDENT_ASSISTANT_REPLY = "done, the file said hello";

/**
 * The surface dimensions whose domain truth the harness asserts equivalent.
 * Per D2 (decisions.md #2) this is a FOCUSED conformance: all three surfaces read
 * conversation-domain truth through the SAME read-only
 * `ConversationProjectionReadPort`, so the cross-surface dimension is realized as
 * "materialize the recovered domain through the shared port, once per surface
 * reader, and assert equivalence" — NOT a long-running multi-binary soak.
 */
export const INCIDENT_SURFACES = ["tui", "cli", "headless"] as const;
export type IncidentSurface = (typeof INCIDENT_SURFACES)[number];
