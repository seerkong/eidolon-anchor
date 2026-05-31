/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js"
import type { KeybindsConfig } from "@terminal/core/AIAgent"
import { COMMAND_ID, SLASH_COMMANDS, type CommandID } from "../../../commands/catalog"
import { DialogHelp } from "../../../ui/dialog/help"
import { DialogAgent } from "./agent/agent-dialog"
import { DialogMcp } from "./mcp/mcp-dialog"
import { DialogModel } from "./provider/model-dialog"
import { DialogProvider } from "./provider/provider-dialog"
import { DialogSessionList } from "./session/session-list-dialog"
import { DialogShortcuts } from "./shortcuts/shortcuts-dialog"
import { DialogStatus } from "./status/status-dialog"
import { DialogThemeList } from "./theme/theme-dialog"

export type TuiA1SystemSurfaceEntry = {
  id: string
  command: CommandID
  title: string
  category: string
  detail: string
  keybind?: keyof KeybindsConfig
  suggested?: boolean
  render: () => JSX.Element
}

const commandSlashSummary = new Map<CommandID, string>()

for (const item of SLASH_COMMANDS) {
  if (commandSlashSummary.has(item.command)) continue
  commandSlashSummary.set(item.command, [item.slash, ...(item.aliases ?? [])].join(", "))
}

const tuiA1SystemSurfaceEntries: TuiA1SystemSurfaceEntry[] = [
  {
    id: "sessions",
    command: COMMAND_ID.SessionList,
    title: "Sessions",
    category: "System",
    detail: "switch or manage session history",
    keybind: "session_list",
    suggested: true,
    render: () => <DialogSessionList />,
  },
  {
    id: "provider-connect",
    command: COMMAND_ID.ProviderConnect,
    title: "Connect Provider",
    category: "Models",
    detail: "authenticate or enable a provider",
    suggested: true,
    render: () => <DialogProvider />,
  },
  {
    id: "models",
    command: COMMAND_ID.ModelList,
    title: "Models",
    category: "Models",
    detail: "inspect or change the current model",
    keybind: "model_list",
    suggested: true,
    render: () => <DialogModel />,
  },
  {
    id: "agents",
    command: COMMAND_ID.AgentList,
    title: "Agents",
    category: "System",
    detail: "switch the current agent persona",
    keybind: "agent_list",
    suggested: true,
    render: () => <DialogAgent />,
  },
  {
    id: "mcp",
    command: COMMAND_ID.McpList,
    title: "MCP Servers",
    category: "System",
    detail: "inspect, toggle, or reconnect MCP servers",
    suggested: true,
    render: () => <DialogMcp />,
  },
  {
    id: "status",
    command: COMMAND_ID.Status,
    title: "Status",
    category: "System",
    detail: "inspect current runtime and surface state",
    keybind: "status_view",
    suggested: true,
    render: () => <DialogStatus />,
  },
  {
    id: "shortcuts",
    command: COMMAND_ID.Shortcuts,
    title: "Shortcuts",
    category: "System",
    detail: "browse categorized keyboard bindings",
    keybind: "shortcuts_view",
    suggested: true,
    render: () => <DialogShortcuts />,
  },
  {
    id: "appearance",
    command: COMMAND_ID.ThemeSwitch,
    title: "Appearance",
    category: "System",
    detail: "switch the official theme",
    keybind: "theme_list",
    render: () => <DialogThemeList />,
  },
  {
    id: "help",
    command: COMMAND_ID.HelpShow,
    title: "Help",
    category: "System",
    detail: "open guidance and usage help",
    suggested: true,
    render: () => <DialogHelp />,
  },
]

export function getTuiA1SystemSurfaceEntries() {
  return tuiA1SystemSurfaceEntries
}

export function getTuiA1ManagementSurfaceEntries() {
  return tuiA1SystemSurfaceEntries.filter((entry) => entry.command !== COMMAND_ID.Status && entry.command !== COMMAND_ID.HelpShow)
}

export function getCommandSlashSummary(command: CommandID) {
  return commandSlashSummary.get(command)
}
