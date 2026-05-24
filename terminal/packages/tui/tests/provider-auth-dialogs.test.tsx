/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount, type JSX } from "solid-js"
import type {
  Agent,
  Config,
  Event,
  Provider,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
  ProviderListResponse,
  TuiRuntimeSdk,
} from "@terminal/core/AIAgent"
import { ArgsProvider } from "../src/providers/args"
import { ExitProvider } from "../src/providers/exit"
import { KVProvider } from "../src/providers/kv"
import { KeybindProvider } from "../src/providers/keybind"
import { RuntimeClientProvider } from "../src/providers/runtime-client"
import { ThemeProvider } from "../src/providers/theme"
import { defaultTuiA1Selection } from "../src/app/tui_a1/data"
import { RouteProvider } from "../src/app/tui_a1/route/route-context"
import { DialogProvider as ProviderAuthDialog } from "../src/app/tui_a1/system/provider/provider-dialog"
import { LocalProvider } from "../src/app/tui_a1/state/local-context"
import { SyncProvider } from "../src/app/tui_a1/state/sync-context"
import { TuiA1StateProvider } from "../src/app/tui_a1/state/state-context"
import { DialogProvider, useDialog } from "../src/ui/dialog/context"
import { ToastProvider } from "../src/ui/toast/toast"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
const providerID = "oauth-test"
const modelID = "chat"

async function renderSettled(setup: Awaited<ReturnType<typeof testRender>>, passes = 4) {
  for (let index = 0; index < passes; index += 1) {
    await tick()
    await setup.renderOnce()
  }
}

function captureText(setup: Awaited<ReturnType<typeof testRender>>) {
  const frame = setup.captureSpans()
  return frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
}

function OpenDialogOnMount(props: { render: () => JSX.Element }) {
  const dialog = useDialog()

  onMount(() => {
    dialog.replace(props.render)
  })

  return <box width="100%" height="100%" />
}

function buildProvider(): Provider {
  return {
    id: providerID,
    name: "OAuth Test",
    source: "builtin",
    env: [],
    options: {},
    models: {
      [modelID]: {
        id: modelID,
        providerID,
        api: { id: providerID, url: "", npm: "@terminal/organ" },
        name: "OAuth Chat",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: { text: true, image: true },
          output: { text: true },
        },
        cost: {
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
        },
        limit: {
          context: 8000,
          output: 4096,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2024-01-01",
        variants: {},
      },
    },
  }
}

function buildProviderList(provider: Provider): ProviderListResponse {
  const model = provider.models[modelID]
  return {
    all: [
      {
        id: provider.id,
        name: provider.name,
        env: [],
        api: "",
        npm: "@terminal/organ",
        models: {
          [modelID]: {
            id: model.id,
            name: model.name,
            release_date: model.release_date,
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            interleaved: true,
            cost: {
              input: 0,
              output: 0,
              cache_read: 0,
              cache_write: 0,
            },
            limit: {
              context: 8000,
              output: 4096,
            },
            options: {},
          },
        },
      },
    ],
    default: {
      [provider.id]: modelID,
    },
    connected: [],
  }
}

function createProviderAuthRuntime(options?: {
  authorize?: (input: { providerID: string; method: number }) => Promise<{ data?: ProviderAuthAuthorization; error?: unknown }>
  callback?: (input: { providerID: string; method: number; code?: string }) => Promise<{ data?: unknown; error?: unknown }>
}): TuiRuntimeSdk {
  const base = createTuiRuntimeClient({ mode: "mock" })
  const provider = buildProvider()
  const providerList = buildProviderList(provider)
  const authMethods: ProviderAuthMethod[] = [
    { type: "oauth", label: "Browser OAuth" },
    { type: "api", label: "API key" },
  ]
  const config: Config = {
    theme: "eidolon-flat",
    model: `${providerID}/${modelID}`,
    keybinds: {},
    plugin: [],
    experimental: {},
  }
  const agents: Agent[] = [
    {
      name: "build",
      description: "Build",
      mode: "primary",
      permission: [],
      options: {},
      model: { providerID, modelID },
    },
  ]

  return {
    ...base,
    client: {
      ...base.client,
      config: {
        ...base.client.config,
        get: async () => ({ data: config }),
        providers: async () => ({
          data: {
            providers: [provider],
            default: providerList.default,
            connected: providerList.connected,
          },
        }),
      },
      app: {
        ...base.client.app,
        agents: async () => ({ data: agents }),
      },
      provider: {
        ...base.client.provider,
        list: async () => ({ data: providerList }),
        auth: async () => ({ data: { [providerID]: authMethods } }),
        oauth: {
          authorize:
            options?.authorize ??
            (async () => ({
              data: {
                method: "auto",
                url: "https://auth.example.test/device",
                instructions: "Enter ABCD-1234 at the browser",
              },
            })),
          callback: options?.callback ?? (async () => ({ data: true })),
        },
      },
    },
    event: {
      ...base.event,
      subscribe: async () => ({
        stream: (async function* (): AsyncGenerator<Event, void, unknown> {})(),
      }),
    },
  }
}

function renderProviderAuthHarness(client: TuiRuntimeSdk) {
  return (
    <ArgsProvider>
      <ExitProvider onExit={async () => {}}>
        <KVProvider>
          <RuntimeClientProvider url="mock" client={client}>
            <ToastProvider>
              <SyncProvider>
                <ThemeProvider mode="dark">
                  <KeybindProvider>
                    <TuiA1StateProvider
                      runtimeEnabled={true}
                      selection={{ ...defaultTuiA1Selection, providerID, modelID }}
                    >
                      <RouteProvider>
                        <LocalProvider>
                          <DialogProvider>
                            <OpenDialogOnMount render={() => <ProviderAuthDialog />} />
                          </DialogProvider>
                        </LocalProvider>
                      </RouteProvider>
                    </TuiA1StateProvider>
                  </KeybindProvider>
                </ThemeProvider>
              </SyncProvider>
            </ToastProvider>
          </RuntimeClientProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  )
}

describe("provider auth dialogs", () => {
  it("opens the multiple auth method selector when a provider exposes OAuth and API methods", async () => {
    const setup = await testRender(() => renderProviderAuthHarness(createProviderAuthRuntime()), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 6)
      expect(captureText(setup)).toContain("Connect a provider")

      setup.mockInput.pressEnter()
      await renderSettled(setup, 4)

      const text = captureText(setup)
      expect(text).toContain("Select auth method")
      expect(text).toContain("Browser OAuth")
      expect(text).toContain("API key")
      expect(text).toContain("[清空]")
      expect(text).toContain("[关闭(esc)]")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("shows OAuth auto authorization details while waiting for callback completion", async () => {
    let resolveCallback: (() => void) | undefined
    const callbackGate = new Promise<void>((resolve) => {
      resolveCallback = resolve
    })
    const client = createProviderAuthRuntime({
      callback: async () => {
        await callbackGate
        return { data: true }
      },
    })
    const setup = await testRender(() => renderProviderAuthHarness(client), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 6)
      setup.mockInput.pressEnter()
      await renderSettled(setup, 4)
      setup.mockInput.pressEnter()
      await renderSettled(setup, 4)

      const waitingText = captureText(setup)
      expect(waitingText).toContain("Browser OAuth")
      expect(waitingText).toContain("https://auth.example.test/device")
      expect(waitingText).toContain("Enter ABCD-1234 at the browser")
      expect(waitingText).toContain("Waiting for authorization...")
      expect(waitingText).toContain("[复制]")

      resolveCallback?.()
      await renderSettled(setup, 8)

      const completedText = captureText(setup)
      expect(completedText).toContain("OAuth Test")
      expect(completedText).toContain("OAuth Chat")
    } finally {
      resolveCallback?.()
      setup.renderer.destroy()
    }
  })
})
