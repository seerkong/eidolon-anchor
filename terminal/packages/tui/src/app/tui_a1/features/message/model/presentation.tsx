import { createContext, createSignal, useContext } from "solid-js"

export function createMessagePresentationStore(limit = 256) {
  const entries = new Map<string, { expanded: boolean; revision: number }>()
  const [epoch, setEpoch] = createSignal(0)
  return {
    epoch,
    get(id: string) { epoch(); return entries.get(id)?.expanded ?? false },
    revision(id: string) { return entries.get(id)?.revision ?? 0 },
    set(id: string, expanded: boolean) {
      const previous = entries.get(id)
      entries.delete(id)
      entries.set(id, { expanded, revision: (previous?.revision ?? 0) + 1 })
      while (entries.size > limit) entries.delete(entries.keys().next().value!)
      setEpoch(value => value + 1)
    },
    clear() { entries.clear(); setEpoch(value => value + 1) },
    size: () => entries.size,
  }
}

export const MessagePresentationContext = createContext<{
  expanded: () => boolean
  setExpanded: (value: boolean) => void
}>()

export function useMessageExpansion() {
  const supplied = useContext(MessagePresentationContext)
  const [expanded, setExpanded] = createSignal(false)
  return supplied ?? { expanded, setExpanded }
}
