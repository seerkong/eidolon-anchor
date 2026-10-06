import type { MessagePreview } from "./Observation"

export type HistoryPage = Readonly<{
  actorId: string
  epoch: string
  historyRevision: string
  messages: readonly MessagePreview[]
  nextCursor?: string
}>

export type MessageContentChunk = Readonly<{
  codec: "public-message-json-v1"
  encoding: "base64"
  messageId: string
  historyRevision: string
  offsetBytes: number
  totalBytes: number
  data: string
  nextCursor?: string
}>
