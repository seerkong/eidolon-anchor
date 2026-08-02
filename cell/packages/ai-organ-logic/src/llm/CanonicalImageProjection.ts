import { createHash } from "node:crypto";

import type { InputContentPart, InputImageContentPart } from "@shared/composer";

export const OPENAI_IMAGE_MIME_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const);

export const DEFAULT_MAX_CANONICAL_IMAGE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_CANONICAL_IMAGE_TOTAL_BYTES = 50 * 1024 * 1024;

export type CanonicalImageValidationOptions = Readonly<{
  allowedMimeTypes?: readonly string[];
  maxBytes?: number;
}>;

export type CanonicalImageSummary = Readonly<{
  mime: string;
  size: number;
  digest: string;
}>;

export type CanonicalImageProjectionOptions = CanonicalImageValidationOptions & Readonly<{
  maxTotalBytes?: number;
}>;

type ValidatedCanonicalImage = CanonicalImageSummary & Readonly<{
  dataUrl: string;
}>;

export type OpenAIChatUserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type OpenAIResponsesUserContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

function safePositiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function parseBase64ImageDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || match[2].length === 0 || match[2].length % 4 !== 0) {
    throw new TypeError("Canonical image must use a valid base64 data URL");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0) {
    throw new TypeError("Canonical image data URL has no image bytes");
  }
  return { mime: match[1].toLowerCase(), bytes };
}

export function validateCanonicalImage(
  part: InputImageContentPart,
  options: CanonicalImageValidationOptions = {},
): ValidatedCanonicalImage {
  const mime = String(part.mime || "").toLowerCase();
  const allowedMimeTypes = new Set(
    (options.allowedMimeTypes ?? OPENAI_IMAGE_MIME_TYPES).map((value) => value.toLowerCase()),
  );
  if (!allowedMimeTypes.has(mime)) {
    throw new TypeError(`Unsupported canonical image MIME '${mime || "unknown"}'`);
  }

  const parsed = parseBase64ImageDataUrl(part.dataUrl);
  if (parsed.mime !== mime) {
    throw new TypeError(`Canonical image MIME '${mime}' does not match data URL MIME '${parsed.mime}'`);
  }

  const declaredSize = typeof part.size === "number" && Number.isFinite(part.size)
    ? Math.max(0, Math.floor(part.size))
    : 0;
  const size = Math.max(declaredSize, parsed.bytes.byteLength);
  const maxBytes = safePositiveLimit(options.maxBytes, DEFAULT_MAX_CANONICAL_IMAGE_BYTES);
  if (size > maxBytes) {
    throw new RangeError(`Canonical image size ${size} exceeds maximum ${maxBytes} bytes`);
  }

  const digest = typeof part.sourceDigest === "string" && part.sourceDigest
    ? part.sourceDigest
    : `sha256:${createHash("sha256").update(parsed.bytes).digest("hex")}`;
  return Object.freeze({ mime, dataUrl: part.dataUrl, size, digest });
}

export function summarizeCanonicalImage(
  part: InputImageContentPart,
  options: CanonicalImageValidationOptions = {},
): CanonicalImageSummary {
  const { mime, size, digest } = validateCanonicalImage(part, options);
  return Object.freeze({ mime, size, digest });
}

function summarizeImageDataUrl(dataUrl: string, declaredMime?: string): CanonicalImageSummary {
  const parsed = parseBase64ImageDataUrl(dataUrl);
  const mime = declaredMime?.toLowerCase() || parsed.mime;
  if (mime !== parsed.mime || !OPENAI_IMAGE_MIME_TYPES.includes(mime as any)) {
    throw new TypeError("Unsupported or mismatched image data URL MIME");
  }
  return Object.freeze({
    mime,
    size: parsed.bytes.byteLength,
    digest: `sha256:${createHash("sha256").update(parsed.bytes).digest("hex")}`,
  });
}

/** Deep observation/log copy with image bytes and local image metadata removed. */
export function redactCanonicalImages<T>(value: T): T {
  const copied = structuredClone(value);
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    const record = entry as Record<string, unknown>;
    let summary: CanonicalImageSummary | undefined;
    try {
      if (record.type === "image" && typeof record.dataUrl === "string") {
        summary = summarizeCanonicalImage(record as unknown as InputImageContentPart);
        delete record.dataUrl;
        delete record.filename;
        delete record.source;
        delete record.path;
      } else if (record.type === "image_url" && record.image_url && typeof record.image_url === "object") {
        const imageUrl = record.image_url as Record<string, unknown>;
        if (typeof imageUrl.url === "string" && imageUrl.url.startsWith("data:")) {
          summary = summarizeImageDataUrl(imageUrl.url);
          record.image_url = summary;
        }
      } else if (record.type === "input_image" && typeof record.image_url === "string" && record.image_url.startsWith("data:")) {
        summary = summarizeImageDataUrl(record.image_url);
        delete record.image_url;
      }
    } catch {
      summary = Object.freeze({ mime: "redacted", size: 0, digest: "redacted" });
      delete record.dataUrl;
      delete record.filename;
      delete record.source;
      delete record.path;
      if (record.type === "image_url") record.image_url = summary;
      if (record.type === "input_image") delete record.image_url;
    }
    if (summary) record.image = summary;
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(copied);
  return copied;
}

function projectCanonicalUserContent<T>(
  content: readonly InputContentPart[],
  options: CanonicalImageProjectionOptions,
  imageProjector: (image: ValidatedCanonicalImage) => T,
  textProjector: (text: string) => T,
): T[] {
  const projected: T[] = [];
  let totalImageBytes = 0;
  const maxTotalBytes = safePositiveLimit(
    options.maxTotalBytes,
    DEFAULT_MAX_CANONICAL_IMAGE_TOTAL_BYTES,
  );
  for (const part of content) {
    if (part.type === "text") {
      projected.push(textProjector(part.text));
      continue;
    }
    if (part.type === "file_reference") {
      throw new TypeError("Local file reference reached the provider projection boundary");
    }
    const image = validateCanonicalImage(part, options);
    totalImageBytes += image.size;
    if (totalImageBytes > maxTotalBytes) {
      throw new RangeError(`Canonical image total size exceeds maximum ${maxTotalBytes} bytes`);
    }
    projected.push(imageProjector(image));
  }
  return projected;
}

export function projectOpenAIChatUserContent(
  content: readonly InputContentPart[],
  options: CanonicalImageProjectionOptions = {},
): OpenAIChatUserContentPart[] {
  return projectCanonicalUserContent<OpenAIChatUserContentPart>(
    content,
    options,
    (image) => ({ type: "image_url", image_url: { url: image.dataUrl } }),
    (text) => ({ type: "text", text }),
  );
}

export function projectOpenAIResponsesUserContent(
  content: readonly InputContentPart[],
  options: CanonicalImageProjectionOptions = {},
): OpenAIResponsesUserContentPart[] {
  return projectCanonicalUserContent<OpenAIResponsesUserContentPart>(
    content,
    options,
    (image) => ({ type: "input_image", image_url: image.dataUrl }),
    (text) => ({ type: "input_text", text }),
  );
}
