import type {
  Agent,
  Config,
  Provider,
  ProviderAuthMethod,
  ProviderListResponse,
} from "@terminal/core/AIAgent"
import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig"
import { parseModelRef } from "@terminal/core/AIAgent"
import { resolvePresetModelRef } from "@cell/ai-organ-logic/llm"
import { assembleAiCodingRuntimeProfile } from "@cell/mod-profiles"

export type RuntimeClientMode = "mock" | "local-runtime"
export type RuntimeModel = { providerID: string; modelID: string }
export type RuntimeCatalog = {
  sessionTitle: string
  defaultModel: RuntimeModel
  providers: Provider[]
  providerList: ProviderListResponse
  providerAuthMethods: Record<string, ProviderAuthMethod[]>
  config: Config
  agents: Agent[]
}

type RuntimeCatalogAssembly = Pick<
  ReturnType<typeof assembleAiCodingRuntimeProfile>,
  "agentConfigs" | "runtimeCatalog"
>

const MOCK_PROVIDER_ID = "eidolon"
const MOCK_PROVIDER_NAME = "Eidolon Starter"
const MOCK_MODEL_ID = "shell-default"

const defaultRuntimeModel: RuntimeModel = {
  providerID: MOCK_PROVIDER_ID,
  modelID: MOCK_MODEL_ID,
}

const mockProviders: Provider[] = [
  {
    id: MOCK_PROVIDER_ID,
    name: MOCK_PROVIDER_NAME,
    source: "builtin",
    env: [],
    options: {},
    models: {
      [MOCK_MODEL_ID]: {
        id: MOCK_MODEL_ID,
        providerID: MOCK_PROVIDER_ID,
        api: { id: MOCK_PROVIDER_ID, url: "", npm: "@terminal/organ" },
        name: "Shell Default",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: true },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
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
        variants: {
          fast: {},
        },
      },
    },
  },
]

const providerListResponse: ProviderListResponse = {
  all: [
    {
      id: MOCK_PROVIDER_ID,
      name: MOCK_PROVIDER_NAME,
      env: [],
      api: "",
      npm: "@terminal/organ",
      models: {
        [MOCK_MODEL_ID]: {
          id: MOCK_MODEL_ID,
          name: "Shell Default",
          release_date: "2024-01-01",
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
    [MOCK_PROVIDER_ID]: MOCK_MODEL_ID,
  },
  connected: [MOCK_PROVIDER_ID],
}

const providerAuthMethods: Record<string, ProviderAuthMethod[]> = {
  [MOCK_PROVIDER_ID]: [
    {
      type: "api",
      label: "API key",
    },
  ],
}

const mockConfig: Config = {
  theme: "eidolon-flat",
  keybinds: {
    leader: "ctrl+x",
    app_exit: "ctrl+d,<leader>q",
    editor_open: "<leader>e",
    theme_list: "<leader>t",
    sidebar_toggle: "<leader>b",
    scrollbar_toggle: "none",
    username_toggle: "none",
    status_view: "<leader>s",
    shortcuts_view: "<leader>/",
    session_export: "<leader>x",
    session_new: "<leader>n",
    session_list: "<leader>l",
    session_timeline: "<leader>g",
    session_fork: "none",
    session_rename: "none",
    session_share: "none",
    session_unshare: "none",
    session_interrupt: "escape",
    session_compact: "<leader>c",
    messages_page_up: "pageup",
    messages_page_down: "pagedown",
    messages_half_page_up: "ctrl+alt+u",
    messages_half_page_down: "ctrl+alt+d",
    messages_first: "ctrl+g,home",
    messages_last: "ctrl+alt+g,end",
    messages_next: "none",
    messages_previous: "none",
    messages_last_user: "none",
    messages_copy: "<leader>y",
    messages_undo: "<leader>u",
    messages_redo: "<leader>r",
    messages_toggle_conceal: "<leader>h",
    tool_details: "none",
    model_list: "<leader>m",
    model_cycle_recent: "f2",
    model_cycle_recent_reverse: "shift+f2",
    model_cycle_favorite: "none",
    model_cycle_favorite_reverse: "none",
    command_list: "ctrl+p",
    agent_list: "<leader>a",
    agent_cycle: "tab",
    agent_cycle_reverse: "shift+tab",
    variant_cycle: "ctrl+t",
    input_clear: "ctrl+shift+l",
    input_paste: "ctrl+v",
    input_submit: "return",
    input_newline: "shift+return,ctrl+return,ctrl+j",
    input_move_left: "left,ctrl+b",
    input_move_right: "right,ctrl+f",
    input_move_up: "up",
    input_move_down: "down",
    input_select_left: "shift+left",
    input_select_right: "shift+right",
    input_select_up: "shift+up",
    input_select_down: "shift+down",
    input_line_home: "ctrl+a",
    input_line_end: "ctrl+e",
    input_select_line_home: "ctrl+shift+a",
    input_select_line_end: "ctrl+shift+e",
    input_visual_line_home: "alt+a",
    input_visual_line_end: "alt+e",
    input_select_visual_line_home: "alt+shift+a",
    input_select_visual_line_end: "alt+shift+e",
    input_buffer_home: "home",
    input_buffer_end: "end",
    input_select_buffer_home: "shift+home",
    input_select_buffer_end: "shift+end",
    input_delete_line: "ctrl+shift+d",
    input_delete_to_line_end: "ctrl+k",
    input_delete_to_line_start: "ctrl+u",
    input_backspace: "backspace,shift+backspace",
    input_delete: "ctrl+d,delete,shift+delete",
    input_undo: "ctrl+-,super+z",
    input_redo: "ctrl+.,super+shift+z",
    input_word_forward: "alt+f,alt+right,ctrl+right",
    input_word_backward: "alt+b,alt+left,ctrl+left",
    input_select_word_forward: "alt+shift+f,alt+shift+right",
    input_select_word_backward: "alt+shift+b,alt+shift+left",
    input_delete_word_forward: "alt+d,alt+delete,ctrl+delete",
    input_delete_word_backward: "ctrl+w,ctrl+backspace,alt+backspace",
    history_previous: "up",
    history_next: "down",
    session_child_cycle: "<leader>right",
    session_child_cycle_reverse: "<leader>left",
    session_parent: "<leader>up",
    terminal_suspend: "ctrl+z",
    terminal_title_toggle: "none",
    tips_toggle: "<leader>h",
  },
  tui: {
    scroll_speed: 3,
    scroll_acceleration: { enabled: true },
    diff_style: "auto",
  },
  share: "manual",
  model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
  plugin: [],
  experimental: {
    disable_paste_summary: false,
  },
}

function buildModelCapabilities() {
  return {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  }
}

function makeProviderModel(providerID: string, modelID: string, apiUrl: string, contextLimit: number, outputLimit: number) {
  return {
    id: modelID,
    providerID,
    api: { id: providerID, url: apiUrl, npm: "@cell/ai-organ-logic" },
    name: modelID,
    capabilities: buildModelCapabilities(),
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: {
      context: contextLimit,
      output: outputLimit,
    },
    status: "active" as const,
    options: {},
    headers: {},
    release_date: "2024-01-01",
    variants: {
      fast: {},
    },
  }
}

function makeProviderListModel(modelID: string, contextLimit: number, outputLimit: number) {
  return {
    id: modelID,
    name: modelID,
    release_date: "2024-01-01",
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
      context: contextLimit,
      output: outputLimit,
    },
    options: {},
  }
}

function buildDefaultAgents(defaultModel: RuntimeModel): Agent[] {
  return [
    {
      name: "build",
      description: "Implement code changes and complete the task end to end",
      mode: "primary",
      permission: [],
      options: {},
      color: "#33a1ff",
      model: defaultModel,
    },
    {
      name: "plan",
      description: "Reason about scope, constraints, and the execution plan before editing",
      mode: "primary",
      permission: [],
      options: {},
      color: "#f5a623",
    },
    {
      name: "explore",
      description: "Inspect the codebase and gather facts before making changes",
      mode: "primary",
      permission: [],
      options: {},
      color: "#7ed321",
    },
    {
      name: "general",
      description: "Handle mixed runtime tasks when no specialized agent role fits",
      mode: "primary",
      permission: [],
      options: {},
      color: "#9b59b6",
    },
  ]
}

function buildAssemblyAgents(
  defaultModel: RuntimeModel,
  agentConfigs: Readonly<Record<string, AgentConfig>>,
): Agent[] {
  const agents = Object.values(agentConfigs).map((config) => ({
    name: config.name,
    description: config.description,
    mode: "primary" as const,
    permission: [],
    options: {},
    model: defaultModel,
  }))
  return agents.length > 0 ? agents : buildDefaultAgents(defaultModel)
}

let runtimeCatalogAssemblyFactoryOverride: null | ((directory: string) => RuntimeCatalogAssembly) = null

export function __setRuntimeCatalogAssemblyFactoryForTest(
  factory: null | ((directory: string) => RuntimeCatalogAssembly),
) {
  runtimeCatalogAssemblyFactoryOverride = factory
}

function createRuntimeCatalogAssembly(directory: string): RuntimeCatalogAssembly {
  if (runtimeCatalogAssemblyFactoryOverride) {
    return runtimeCatalogAssemblyFactoryOverride(directory)
  }
  return assembleAiCodingRuntimeProfile({
    workDir: directory,
    skillsDescription: "",
    loadedAgents: {},
    delegateAgentDescriptions: "",
  })
}

function resolveLocalRuntimeCatalog(directory: string): RuntimeCatalog {
  const assembly = createRuntimeCatalogAssembly(directory)
  const configBundle = assembly.runtimeCatalog?.loadConfigBundle(directory)
  if (!configBundle) {
    throw new Error("Local runtime catalog unavailable: runtime profile did not provide a config bundle")
  }

  const { providerConfig, presetConfig } = configBundle
  const configuredProviders = providerConfig?.providers ?? []
  if (configuredProviders.length === 0) {
    throw new Error("LLM provider catalog unavailable: configure .eidolon/llm-provider.json or ~/.eidolon/llm-provider.json")
  }

  const providers = configuredProviders.map((provider) => ({
    id: provider.name,
    name: provider.name,
    source: "api" as const,
    env: [],
    options: {},
    models: Object.fromEntries(
      provider.models.map((model) => [
        model.name,
        makeProviderModel(provider.name, model.name, provider.baseURL ?? "", model.context ?? 0, model.output ?? 0),
      ]),
    ),
  }))

  const defaultModel =
    parseModelRef(presetConfig ? resolvePresetModelRef(presetConfig, "main") : "")
    ?? (() => {
      const provider = providers[0]
      const modelID = Object.keys(provider?.models ?? {})[0]
      if (provider && modelID) return { providerID: provider.id, modelID }
      throw new Error("LLM provider catalog contains no models")
    })()

  const providerList: ProviderListResponse = {
    all: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      env: [],
      api: Object.values(provider.models)[0]?.api?.url ?? "",
      npm: "@cell/ai-organ-logic",
      models: Object.fromEntries(
        Object.values(provider.models).map((model) => {
          const limit = model.limit ?? { context: 0, output: 0 }
          return [model.id, makeProviderListModel(model.id, limit.context ?? 0, limit.output ?? 0)]
        }),
      ),
    })),
    default: Object.fromEntries(
      providers
        .map((provider) => {
          const modelID = Object.keys(provider.models)[0]
          return modelID ? [provider.id, provider.id === defaultModel.providerID ? defaultModel.modelID : modelID] : null
        })
        .filter(Boolean) as Array<[string, string]>,
    ),
    connected: providers.map((provider) => provider.id),
  }

  const providerAuthMethods = Object.fromEntries(
    providers.map((provider) => [
      provider.id,
      [
        {
          type: "api",
          label: "API key",
        },
      ],
    ]),
  )

  return {
    sessionTitle: "Local Session",
    defaultModel,
    providers,
    providerList,
    providerAuthMethods,
    config: {
      ...mockConfig,
      model: `${defaultModel.providerID}/${defaultModel.modelID}`,
    },
    agents: buildAssemblyAgents(defaultModel, assembly.agentConfigs),
  }
}

export function createRuntimeCatalog(mode: RuntimeClientMode, directory: string): RuntimeCatalog {
  if (mode === "local-runtime") {
    return resolveLocalRuntimeCatalog(directory)
  }

  return {
    sessionTitle: "Mock Session",
    defaultModel: defaultRuntimeModel,
    providers: mockProviders,
    providerList: providerListResponse,
    providerAuthMethods,
    config: mockConfig,
    agents: buildDefaultAgents(defaultRuntimeModel),
  }
}
