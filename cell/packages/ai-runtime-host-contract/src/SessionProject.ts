/** Public placement, owned by the host's durable session registry.
 * An unknown old record is not an explicitly projectless conversation.
 * workspaceId is canonical within this endpoint; displayName is presentation only.
 */
export type SessionProjectContext = Readonly<
  | { kind: "workspace"; workspaceId: string; displayName: string; workDir: string }
  | { kind: "independent" }
  | { kind: "unknown" }
>
