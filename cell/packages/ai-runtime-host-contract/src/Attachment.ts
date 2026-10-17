export type AttachmentMime = "text/plain" | "image/png" | "image/jpeg" | "image/webp"
export type HostInputPart = Readonly<
  | { type: "text"; text: string; filename?: string }
  | { type: "image"; mime: Exclude<AttachmentMime, "text/plain">; dataUrl: string; filename?: string }
  | { type: "attachment"; attachmentId: string }
>
export type AttachmentOperation = Readonly<
  | { kind: "begin"; expectedEpoch: string; uploadId: string; filename: string; mime: AttachmentMime; totalBytes: number; digest: string }
  | { kind: "append"; expectedEpoch: string; attachmentId: string; offsetBytes: number; data: string }
  | { kind: "release"; expectedEpoch: string; attachmentId: string }
>
export type AttachmentSummary = Readonly<{
  attachmentId: string; epoch: string; state: "uploading" | "ready" | "released" | "expired" | "failed"
  filename: string; mime: AttachmentMime; uploadedBytes: number; totalBytes: number; expiresAt: number; digest?: string
}>
