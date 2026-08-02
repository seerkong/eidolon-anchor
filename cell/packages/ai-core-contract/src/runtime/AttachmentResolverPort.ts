import type { InputContentPart, InputFileReferenceContentPart } from "@shared/composer";

export interface AttachmentResolverPort {
  resolve(reference: InputFileReferenceContentPart): Promise<Exclude<InputContentPart, InputFileReferenceContentPart>>;
}

export const AttachmentResolverPort = Symbol.for("eidolon.AttachmentResolverPort");
export const ATTACHMENT_RESOLVER_PORT = AttachmentResolverPort;

export function isAttachmentResolverPort(value: unknown): value is AttachmentResolverPort {
  return !!value && typeof value === "object" && typeof (value as { resolve?: unknown }).resolve === "function";
}
