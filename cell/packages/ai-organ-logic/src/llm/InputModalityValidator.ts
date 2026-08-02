import { createHash } from "node:crypto";

import type { LlmModelModalities } from "@cell/ai-core-contract/LlmTypes";
import type { InputContentPart } from "@shared/composer";
import {
  DEFAULT_MAX_CANONICAL_IMAGE_BYTES,
  OPENAI_IMAGE_MIME_TYPES,
  validateCanonicalImage,
} from "./CanonicalImageProjection";

const KNOWN_MODALITIES = new Set(["text", "image", "audio", "video", "pdf"]);

export type UnsupportedModalityDiagnostic = Readonly<{
  kind: "unsupported_modality";
  model: string;
  modalities?: LlmModelModalities;
  partKind: string;
  mime?: string;
  size?: number;
  digest?: string;
}>;

export type InputModalityValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      error: Readonly<{ code: "unsupported_modality"; message: string }>;
      diagnostic: UnsupportedModalityDiagnostic;
    }>;

export type ValidateInputModalitiesInput = Readonly<{
  modelRef: string;
  modalities?: LlmModelModalities | Readonly<{ input?: readonly string[]; output?: readonly string[] }>;
  content: readonly InputContentPart[];
  allowedImageMimeTypes?: readonly string[];
  maxImageBytes?: number;
  // Callers may carry their observation/send closures in this object. This
  // pure validator intentionally never invokes either side-effect boundary.
  observe?: (event: unknown) => unknown;
  send?: (request: unknown) => unknown;
}>;

function dataUrlByteSize(dataUrl: string): number | undefined {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return undefined;
  const metadata = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (!metadata.endsWith(";base64")) return Buffer.byteLength(decodeURIComponent(payload));
  const normalized = payload.replace(/\s/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function safeDigest(part: InputContentPart): string | undefined {
  if ("sourceDigest" in part && typeof part.sourceDigest === "string" && part.sourceDigest) {
    return part.sourceDigest;
  }
  if (part.type === "image") {
    return `sha256:${createHash("sha256").update(part.dataUrl).digest("hex")}`;
  }
  if (part.type === "text") {
    return `sha256:${createHash("sha256").update(part.text).digest("hex")}`;
  }
  return undefined;
}

function partModality(part: InputContentPart): string {
  if (part.type === "file_reference") return "file_reference";
  return part.type;
}

function buildDiagnostic(
  input: ValidateInputModalitiesInput,
  part: InputContentPart,
  modalities: LlmModelModalities | undefined,
): UnsupportedModalityDiagnostic {
  const size = part.type === "image"
    ? (typeof part.size === "number" ? part.size : dataUrlByteSize(part.dataUrl))
    : part.type === "text" ? Buffer.byteLength(part.text) : undefined;
  return {
    kind: "unsupported_modality",
    model: input.modelRef,
    modalities,
    partKind: partModality(part),
    mime: "mime" in part && typeof part.mime === "string" ? part.mime : undefined,
    size,
    digest: safeDigest(part),
  };
}

function normalizeDeclaredModalities(
  value: ValidateInputModalitiesInput["modalities"],
): LlmModelModalities | undefined {
  if (!value || !Array.isArray(value.input) || !Array.isArray(value.output)) return undefined;
  if (value.input.some((item) => !KNOWN_MODALITIES.has(item))
    || value.output.some((item) => !KNOWN_MODALITIES.has(item))) return undefined;
  return { input: [...value.input] as LlmModelModalities["input"], output: [...value.output] as LlmModelModalities["output"] };
}

export function validateInputModalities(input: ValidateInputModalitiesInput): InputModalityValidationResult {
  const modalities = normalizeDeclaredModalities(input.modalities);
  const allowedImageMimeTypes = input.allowedImageMimeTypes ?? OPENAI_IMAGE_MIME_TYPES;
  const maxImageBytes = input.maxImageBytes ?? DEFAULT_MAX_CANONICAL_IMAGE_BYTES;

  for (const part of input.content) {
    const modality = partModality(part);
    // Modalities were optional before structured attachments existed. Keep
    // legacy text callers compatible while still failing closed for every
    // attachment modality when a catalog is absent or contains unknown values.
    const declared = modality === "text" && !modalities
      ? true
      : modalities?.input.includes(modality as LlmModelModalities["input"][number]) === true;
    let invalidImage = false;
    if (part.type === "image") {
      try {
        validateCanonicalImage(part, { allowedMimeTypes: allowedImageMimeTypes, maxBytes: maxImageBytes });
      } catch {
        invalidImage = true;
      }
    }
    if (declared && !invalidImage) continue;

    const diagnostic = buildDiagnostic(input, part, modalities);
    return {
      ok: false,
      error: {
        code: "unsupported_modality",
        message: `Model '${input.modelRef}' does not support ${modality} input; switch models or remove the attachment.`,
      },
      diagnostic,
    };
  }
  return { ok: true };
}

export class UnsupportedModalityError extends Error {
  readonly code = "unsupported_modality" as const;

  constructor(readonly diagnostic: UnsupportedModalityDiagnostic, message: string) {
    super(message);
    this.name = "UnsupportedModalityError";
  }
}
