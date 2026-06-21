/**
 * Domain-neutral control logic component boundary declarations.
 *
 * A boundary declaration states, for one control-plane logic component, where
 * its pure core logic lives, which effect contracts are injected, what the
 * outer adapter surface is responsible for, and how each public entry is
 * classified on the sync-command / async-message boundary. Declarations are
 * data: conformance tests assert them against the real sources.
 */

export const CONTROL_ENTRY_KINDS = ["sync_command", "async_message"] as const;

export type ControlEntryKind = (typeof CONTROL_ENTRY_KINDS)[number];

export type ControlLogicEntryDeclaration = {
  entryId: string;
  /**
   * sync_command: same-call-stack state advance through a public reducer.
   * async_message: mailbox-delivered coordination that may queue or recover.
   */
  kind: ControlEntryKind;
  description?: string;
};

export type ControlLogicBoundaryLayer = "platform" | "platform_domain_bridge" | "domain";

export type ControlLogicBoundaryDeclaration = {
  id: string;
  layer: ControlLogicBoundaryLayer;
  /** Pure logic entry symbols; they accept an explicit runtime, never reach IO. */
  coreLogicEntries: string[];
  /** Effect contracts the core logic depends on; IO happens behind these only. */
  injectedEffectContracts: string[];
  /** Framework concerns owned by the outer adapter (binding, wrapping, errors). */
  outerAdapterSurface: string[];
  /** Every public entry, classified on the command/message boundary. */
  entries: ControlLogicEntryDeclaration[];
  /** Source patterns the core logic entries must never contain. */
  forbiddenDirectIo: string[];
};

export type ControlLogicBoundaryRegistry = {
  declarations: readonly ControlLogicBoundaryDeclaration[];
  getDeclaration: (componentId: string) => ControlLogicBoundaryDeclaration | null;
  classifyEntry: (componentId: string, entryId: string) => ControlEntryKind | null;
  listCoreLogicEntries: (componentId: string) => string[];
};

export function createControlLogicBoundaryRegistry(
  declarations: ControlLogicBoundaryDeclaration[],
): ControlLogicBoundaryRegistry {
  const byId = new Map<string, ControlLogicBoundaryDeclaration>();
  const entryKindByComponent = new Map<string, Map<string, ControlEntryKind>>();

  for (const declaration of declarations) {
    if (byId.has(declaration.id)) {
      throw new Error(`duplicate control logic boundary declaration id: ${declaration.id}`);
    }
    byId.set(declaration.id, declaration);

    const entryKinds = new Map<string, ControlEntryKind>();
    for (const entry of declaration.entries) {
      if (!(CONTROL_ENTRY_KINDS as readonly string[]).includes(entry.kind)) {
        throw new Error(
          `entry ${declaration.id}/${entry.entryId} has unknown kind ${entry.kind}; expected sync_command or async_message`,
        );
      }
      if (entryKinds.has(entry.entryId)) {
        throw new Error(`duplicate entry id ${entry.entryId} in component ${declaration.id}`);
      }
      entryKinds.set(entry.entryId, entry.kind);
    }
    entryKindByComponent.set(declaration.id, entryKinds);
  }

  return {
    declarations,
    getDeclaration: (componentId) => byId.get(componentId) ?? null,
    classifyEntry: (componentId, entryId) =>
      entryKindByComponent.get(componentId)?.get(entryId) ?? null,
    listCoreLogicEntries: (componentId) => [...(byId.get(componentId)?.coreLogicEntries ?? [])],
  };
}
