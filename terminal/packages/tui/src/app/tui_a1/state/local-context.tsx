import { useGraphSignal } from "depa-data-graph-solid"
import { createStore } from "solid-js/store"
import { batch, createEffect, createMemo, onMount } from "solid-js"
import { useSync } from "./sync-context"
import { useTheme } from "../../../providers/theme"
import { uniqueBy } from "remeda"
import path from "path"
import { parseModelRef } from "@terminal/core/AIAgent"
import { Global } from "../../../support/global"
import { iife } from "../../../support/util/iife"
import { createSimpleContext } from "../../../providers/helper"
import { useToast } from "../../../ui/toast/toast"
import { useArgs } from "../../../providers/args"
import { useRuntimeClient } from "../../../providers/runtime-client"
import { RGBA } from "@opentui/core"
import { useTuiA1State } from "./state-context"
import type { TuiA1Selection } from "../data"

const DELEGATE_MODE = "delegate"

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useRuntimeClient()
    const toast = useToast()
    const { stateGraph } = useTuiA1State()
    const selection = useGraphSignal<TuiA1Selection, undefined>(stateGraph.graph, "selection")

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((x) => x.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    const agent = iife(() => {
      const isDelegateMode = (mode: string | undefined) => mode === DELEGATE_MODE
      const agents = createMemo(() => sync.data.agent.filter((x) => !isDelegateMode(x.mode) && !x.hidden))
      const { theme } = useTheme()
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          const selectedName = selection().agent
          return agents().find((x) => x.name === selectedName) ?? agents()[0]!
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          stateGraph.mergeSelection({ agent: name })
        },
        move(direction: 1 | -1) {
          const list = agents()
          if (!list.length) return
          let next = list.findIndex((x) => x.name === agent.current().name) + direction
          if (next < 0) next = list.length - 1
          if (next >= list.length) next = 0
          const value = list[next]
          if (value) stateGraph.mergeSelection({ agent: value.name })
        },
        color(name: string) {
          const all = sync.data.agent
          const agent = all.find((x) => x.name === name)
          if (agent?.color) return RGBA.fromHex(agent.color)
          const index = all.findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          return colors()[index % colors().length]
        },
      }
    })

    const model = iife(() => {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const file = Bun.file(path.join(Global.Path.state, "model.json"))

      function save() {
        Bun.write(
          file,
          JSON.stringify({
            recent: modelStore.recent,
            favorite: modelStore.favorite,
            variant: modelStore.variant,
          }),
        )
      }

      onMount(() => {
        file
          .json()
          .then((x) => {
            setTimeout(() => {
              if (Array.isArray(x.recent)) setModelStore("recent", x.recent)
              if (Array.isArray(x.favorite)) setModelStore("favorite", x.favorite)
              if (typeof x.variant === "object" && x.variant !== null) setModelStore("variant", x.variant)
            }, 0)
          })
          .catch(() => {})
          .finally(() => {
            setTimeout(() => setModelStore("ready", true), 0)
          })
      })

      const args = useArgs()
      const fallbackModel = createMemo(() => {
        if (args.model) {
          const parsed = parseModelRef(args.model)
          if (parsed && isModelValid(parsed)) {
            return parsed
          }
        }

        if (sync.data.config.model) {
          const parsed = parseModelRef(sync.data.config.model)
          if (parsed && isModelValid(parsed)) {
            return parsed
          }
        }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const modelID = defaultModel ?? firstModel?.id
        if (!modelID) return undefined
        return {
          providerID: provider.id,
          modelID,
        }
      })

      const currentModel = createMemo(() => {
        const selected = selection()
        if (isModelValid(selected)) return selected
        const a = agent.current()
        return (
          getFirstValidModel(
            () => modelStore.model[a.name],
            () => a.model,
            fallbackModel,
          ) ?? undefined
        )
      })

      return {
        current: currentModel,
        recent() {
          return modelStore.recent.filter((item) => isModelValid(item))
        },
        favorite() {
          return modelStore.favorite.filter((item) => isModelValid(item))
        },
        get ready() {
          return modelStore.ready
        },
        info: createMemo(() => {
          const value = currentModel()
          if (!value) return undefined
          const provider = sync.data.provider.find((x) => x.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        parsed() {
          return this.info()
        },
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          setModelStore("model", agent.current().name, { ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          setModelStore("model", agent.current().name, { ...next })
          const uniq = uniqueBy([next, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
          if (uniq.length > 10) uniq.pop()
          setModelStore(
            "recent",
            uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
          )
          save()
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            setModelStore("model", agent.current().name, model)
            const selected = selection()
            if (selected.providerID !== model.providerID || selected.modelID !== model.modelID) {
              stateGraph.mergeSelection(model)
            }
            if (options?.recent) {
              const uniq = uniqueBy([model, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
              if (uniq.length > 10) uniq.pop()
              setModelStore(
                "recent",
                uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
              )
              save()
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          current() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((x) => x.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value)
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    })

    async function refreshMcpStatus() {
      const status = await sdk.client.mcp.status()
      if (status.data) {
        sync.set("mcp", status.data)
      }
      return status.data ?? sync.data.mcp
    }

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      refresh() {
        return refreshMcpStatus()
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
        return refreshMcpStatus()
      },
      async reconnect(name: string) {
        await sdk.client.mcp.disconnect({ name })
        await sdk.client.mcp.connect({ name })
        return refreshMcpStatus()
      },
    }

    // Automatically update model when agent changes
    createEffect(() => {
      const value = agent.current()
      if (value.model) {
        if (isModelValid(value.model)) {
          model.set({
            providerID: value.model.providerID,
            modelID: value.model.modelID,
          })
        } else {
          toast.show({
            variant: "warning",
            message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
            duration: 3000,
          })
        }
      }
    })

    createEffect(() => {
      const selected = selection()
      const allAgents = agent.list()
      if (!allAgents.length) return
      if (!allAgents.some((entry) => entry.name === selected.agent)) {
        stateGraph.mergeSelection({ agent: allAgents[0]?.name })
      }
    })

    createEffect(() => {
      const current = model.current()
      if (!current) return
      const selected = selection()
      if (selected.providerID === current.providerID && selected.modelID === current.modelID) return
      stateGraph.mergeSelection(current)
    })

    const result = {
      model,
      agent,
      mcp,
    }
    return result
  },
})
