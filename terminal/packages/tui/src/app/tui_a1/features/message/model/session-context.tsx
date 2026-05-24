import { RGBA } from "@opentui/core"
import { createContext, useContext } from "solid-js"

export type SessionContextType = {
  width: number
  sessionID: string
  directory: string
  activePermissionCallID?: string
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  diffWrapMode: () => "word" | "none"
  keybindLabel: (key: string) => string
  navigateToSession?: (sessionID: string) => void
  agentColor: (name: string) => RGBA
}

export const sessionContext = createContext<SessionContextType>()

export function useSessionContext() {
  const ctx = useContext(sessionContext)
  if (!ctx) throw new Error("useSessionContext must be used within a Session component")
  return ctx
}
