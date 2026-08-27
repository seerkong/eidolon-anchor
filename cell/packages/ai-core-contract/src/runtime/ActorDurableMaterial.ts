/**
 * Domain-neutral, Actor-owned durable bytes. Entries are content addressed and
 * travel with the Actor snapshot; consumers give the bytes their domain meaning.
 */
export type ActorDurableMaterial = Readonly<{
  schemaVersion: "eidolon.actor-durable-material/v1";
  digest: string;
  encoding: "base64";
  mediaType: string;
  bytes: string;
}>;

export type ActorDurableMaterialIndex = Readonly<
  Record<string, ActorDurableMaterial>
>;

export type ActorDurableMaterialIndexInput = Readonly<Record<string, unknown>>;
