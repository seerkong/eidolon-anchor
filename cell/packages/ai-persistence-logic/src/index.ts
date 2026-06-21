/**
 * @cell/ai-persistence-logic — dedicated session-persistence backplane.
 *
 * Owns the pure-I/O persistence routing (checkpoint-snapshot repository access,
 * derived-projection-cache index read/write, conversation-persistence repo
 * access, snapshot-existence check, deserialize-side shape validation) behind an
 * explicitly-injected capability set. It does NOT depend on @cell/ai-organ-logic;
 * the live-runtime save/recover orchestration consumes this package.
 *
 * See `RuntimePersistenceIo.ts` for the P2 seam rationale.
 */
export * from "./RuntimePersistenceIo";
