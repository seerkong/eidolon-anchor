/** @jsxImportSource @opentui/solid */
import type {
  TuiRuntimeSdk,
} from "@terminal/core/AIAgent"
import { createStore } from "solid-js/store"
import { useRuntimeClient } from "../../../providers/runtime-client"
import { createSimpleContext } from "../../../providers/helper"
import { useExit } from "../../../providers/exit"
import { useArgs } from "../../../providers/args"
import { onMount } from "solid-js"
import { Log } from "../../../support/util/log"
import {
  applySyncEvent,
  bootstrapSyncStore,
  createInitialSyncStore,
  getSessionActivityStatus,
  getSessionById,
  syncSessionData,
  type SyncEvent,
  type SyncStoreState,
} from "./sync-store"

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<SyncStoreState>(createInitialSyncStore())

    const sdk = useRuntimeClient()
    Log.Default.info("tui.sync.init", {
      storeStatus: store.status,
    })

    sdk.event.listen((e: CustomEvent<{ detail: SyncEvent }>) => {
      applySyncEvent({
        event: e.detail.detail,
        store,
        setStore,
        runtimeClient: sdk as unknown as TuiRuntimeSdk,
        bootstrap,
      })
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap() {
      await bootstrapSyncStore({
        runtimeClient: sdk as unknown as TuiRuntimeSdk,
        args,
        store,
        setStore,
        onError: exit,
      })
    }

    onMount(() => {
      bootstrap()
    })

    const fullSyncedSessions = new Set<string>()
    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        return store.status !== "loading"
      },
      session: {
        get(sessionID: string) {
          return getSessionById(store, sessionID)
        },
        status(sessionID: string) {
          return getSessionActivityStatus(store, sessionID)
        },
        async sync(sessionID: string) {
          await syncSessionData({
            sessionID,
            store,
            setStore,
            runtimeClient: sdk as unknown as TuiRuntimeSdk,
            fullSyncedSessions,
          })
        },
      },

      bootstrap,
    }
    return result
  },
})
