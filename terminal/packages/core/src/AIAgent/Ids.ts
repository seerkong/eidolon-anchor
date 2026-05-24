import { makeSessionUlid } from "./SessionId"

export function makeMessageId(): string {
  return makeSessionUlid()
}

export function makePartId(): string {
  return makeSessionUlid()
}
