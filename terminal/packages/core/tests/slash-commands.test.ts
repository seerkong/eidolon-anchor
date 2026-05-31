import { describe, expect, it } from "bun:test"
import {
  expandAiSlashPrompt as expandSlashPrompt,
  getAiSlashNamespaceHelp as getSlashNamespaceHelp,
  resolveAiSlashCommand as resolveSlashCommand,
} from "@cell/mod-ai-kernel"
import type { RuntimeCompositionSlashCommand as SlashCommandDescriptor } from "@cell/membrane/runtime-composition"

const joinTokens = (...parts: string[]) => parts.join("")

const DEFAULT_SLASH_COMMANDS: SlashCommandDescriptor[] = [
  {
    namespace: "goal",
    actions: {
      status: {
        toolName: "GoalCommand",
        parse: { kind: "literal", form: "status" },
        help: "`/goal` or `/goal status` Show the current thread goal",
      },
      set: {
        toolName: "GoalCommand",
        parse: { kind: "rest", form: "set", argName: "objective" },
        help: "`/goal <objective>` or `/goal set <objective>` Set the active thread goal",
      },
      edit: {
        toolName: "GoalCommand",
        parse: { kind: "rest", form: "edit", argName: "objective" },
        help: "`/goal edit <objective>` Replace the current goal objective",
      },
      pause: {
        toolName: "GoalCommand",
        parse: { kind: "literal", form: "pause" },
        help: "`/goal pause` Pause the current goal",
      },
      resume: {
        toolName: "GoalCommand",
        parse: { kind: "literal", form: "resume" },
        help: "`/goal resume` Resume the current goal",
      },
      clear: {
        toolName: "GoalCommand",
        parse: { kind: "literal", form: "clear" },
        help: "`/goal clear` Clear the current goal",
      },
    },
  },
  {
    namespace: "actor",
    actions: {
      assign: {
        toolName: "ActorAssign",
        parse: { kind: "assign" },
        help: "`/actor assign <target> -- <content>` Final reply mode",
        promptForms: ["assign", "assign:r", "assign:n", "assign:s"],
      },
      status: {
        toolName: "ActorStatus",
        parse: { kind: "target", form: "status", argName: "target" },
        help: "`/actor status <target>` Show actor status",
      },
      watch: {
        toolName: "ActorWatch",
        parse: { kind: "target", form: "watch", argName: "target" },
        help: "`/actor watch <target>` Enable watched state",
      },
      unwatch: {
        toolName: "ActorUnwatch",
        parse: { kind: "target", form: "unwatch", argName: "target" },
        help: "`/actor unwatch <target>` Disable watched state",
      },
    },
  },
  {
    namespace: "member",
    actions: {
      create: {
        toolName: "MemberCreate",
        parse: { kind: "create_member", form: "create", defaultAgentType: "code" },
        help: "`/member create <name> [@agent_name] [-- <prompt>]` Create a member",
      },
      list: {
        toolName: "MemberList",
        parse: { kind: "literal", form: "list" },
        help: "`/member list` List members",
      },
      status: {
        toolName: "MemberStatus",
        parse: { kind: "target", form: "status", argName: "target" },
        help: "`/member status <target>` Show member status",
      },
      assign: {
        toolName: "MemberAssign",
        parse: { kind: "assign" },
        help: "`/member assign <target> -- <content>` Final reply mode",
        promptForms: ["assign", "assign:r", "assign:n", "assign:s"],
      },
    },
  },
  {
    namespace: "holon",
    actions: {
      create: {
        toolName: "HolonCreate",
        parse: { kind: "create_holon", form: "create" },
        help: "`/holon create <governance> <name>` Create a holon",
      },
      add: {
        toolName: "HolonAdd",
        parse: { kind: "pair", form: "add", argNames: ["holon", "member"] },
        help: "`/holon add <holon> <member>` Add a member to a holon",
      },
      appoint: {
        toolName: "HolonAppoint",
        parse: { kind: "pair", form: "appoint", argNames: ["holon", "member"] },
        help: "`/holon appoint <holon> <member>` Appoint a leader",
      },
      assign: {
        toolName: "HolonAssign",
        parse: { kind: "assign" },
        help: "`/holon assign <target> -- <content>` Final reply mode",
        promptForms: ["assign", "assign:r", "assign:n", "assign:s"],
      },
      status: {
        toolName: "HolonStatus",
        parse: { kind: "target", form: "status", argName: "target" },
        help: "`/holon status <target>` Show holon status",
      },
    },
  },
]

const CUSTOM_MEMBER_SLASH_COMMANDS: SlashCommandDescriptor[] = [
  {
    namespace: "member",
    actions: {
      create: {
        toolName: "MemberCreate",
        parse: { kind: "create_member", form: "create", defaultAgentType: "code" },
        help: "`/member create <name> [@agent_name] [-- <prompt>]` Create a member",
      },
      status: {
        toolName: "MemberStatus",
        parse: { kind: "target", form: "status", argName: "target" },
        help: "`/member status <target>` Show member status",
      },
      assign: {
        toolName: "MemberAssign",
        parse: { kind: "assign" },
        help: "`/member assign <target> -- <content>` Final reply mode",
        promptForms: ["assign", "assign:r", "assign:n", "assign:s"],
      },
      catalog: {
        toolName: "MemberCatalog",
        parse: { kind: "literal", form: "catalog" },
        help: "`/member catalog` Show the member catalog",
      },
    },
  },
]

function resolve(input: string) {
  return resolveSlashCommand(input, DEFAULT_SLASH_COMMANDS)
}

describe("slash command resolution", () => {
  it("supports /actor assign modes and watch controls", () => {
    const assign = resolve("/actor assign alice -- review the persistence design") as any
    expect(assign?.kind).toBe("direct_execute")
    expect(assign?.namespace).toBe("actor")
    expect(assign?.action).toBe("assign")
    expect(assign?.args).toEqual({ target: "alice", mode: "final", content: "review the persistence design" })

    const assignNone = resolve("/actor assign:n holon:research -- continue silently") as any
    expect(assignNone?.kind).toBe("direct_execute")
    expect(assignNone?.args).toEqual({ target: "holon:research", mode: "none", content: "continue silently" })

    const assignStream = resolve("/actor assign:s holon:alpha -- implement and report progress") as any
    expect(assignStream?.kind).toBe("direct_execute")
    expect(assignStream?.args).toEqual({ target: "holon:alpha", mode: "stream", content: "implement and report progress" })

    const assignExplicitFinal = resolve("/actor assign:r alice -- report back explicitly") as any
    expect(assignExplicitFinal?.kind).toBe("direct_execute")
    expect(assignExplicitFinal?.args).toEqual({ target: "alice", mode: "final", content: "report back explicitly" })

    const watch = resolve("/actor watch alice") as any
    expect(watch?.kind).toBe("direct_execute")
    expect(watch?.action).toBe("watch")
    expect(watch?.args).toEqual({ target: "alice" })

    const unwatch = resolve("/actor unwatch holon:research") as any
    expect(unwatch?.kind).toBe("direct_execute")
    expect(unwatch?.action).toBe("unwatch")
    expect(unwatch?.args).toEqual({ target: "holon:research" })
  })

  it("supports /goal direct objective and controls", () => {
    const set = resolve("/goal ship the persistence recovery track") as any
    expect(set?.kind).toBe("direct_execute")
    expect(set?.namespace).toBe("goal")
    expect(set?.action).toBe("set")
    expect(set?.args).toEqual({ command: "set", objective: "ship the persistence recovery track" })

    const status = resolve("/goal") as any
    expect(status?.action).toBe("status")
    expect(status?.args).toEqual({ command: "status" })

    const pause = resolve("/goal pause") as any
    expect(pause?.action).toBe("pause")
    expect(pause?.args).toEqual({ command: "pause" })

    const edit = resolve("/goal edit updated objective") as any
    expect(edit?.action).toBe("edit")
    expect(edit?.args).toEqual({ command: "edit", objective: "updated objective" })
  })

  it("supports /member create and assign modes", () => {
    const create = resolve("/member create alice @code -- work on persistence recovery") as any
    expect(create?.kind).toBe("direct_execute")
    expect(create?.namespace).toBe("member")
    expect(create?.action).toBe("create")
    expect(create?.args).toEqual({ name: "alice", agent_type: "code", prompt: "work on persistence recovery" })

    const createWithoutPrompt = resolve("/member create alice @code") as any
    expect(createWithoutPrompt?.kind).toBe("direct_execute")
    expect(createWithoutPrompt?.args).toEqual({ name: "alice", agent_type: "code", prompt: "" })

    const status = resolve("/member status alice") as any
    expect(status?.kind).toBe("direct_execute")
    expect(status?.action).toBe("status")
    expect(status?.args).toEqual({ target: "alice" })

    const assign = resolve("/member assign alice -- summarize the bug") as any
    expect(assign?.kind).toBe("direct_execute")
    expect(assign?.action).toBe("assign")
    expect(assign?.args).toEqual({ target: "alice", mode: "final", content: "summarize the bug" })

    const assignStream = resolve("/member assign:s alice -- investigate and keep reporting progress") as any
    expect(assignStream?.kind).toBe("direct_execute")
    expect(assignStream?.args).toEqual({ target: "alice", mode: "stream", content: "investigate and keep reporting progress" })

    const assignExplicitFinal = resolve("/member assign:r alice -- summarize with explicit final mode") as any
    expect(assignExplicitFinal?.kind).toBe("direct_execute")
    expect(assignExplicitFinal?.args).toEqual({ target: "alice", mode: "final", content: "summarize with explicit final mode" })
  })

  it("supports autonomous holon structure and assign commands", () => {
    const create = resolve("/holon create autonomous research") as any
    expect(create?.kind).toBe("direct_execute")
    expect(create?.namespace).toBe("holon")
    expect(create?.action).toBe("create")
    expect(create?.args).toEqual({ governance: "autonomous", name: "research" })

    const add = resolve("/holon add research alice") as any
    expect(add?.kind).toBe("direct_execute")
    expect(add?.action).toBe("add")
    expect(add?.args).toEqual({ holon: "research", member: "alice" })

    const assign = resolve("/holon assign:s research -- implement the migration and report progress") as any
    expect(assign?.kind).toBe("direct_execute")
    expect(assign?.action).toBe("assign")
    expect(assign?.args).toEqual({ target: "research", mode: "stream", content: "implement the migration and report progress" })

    const assignExplicitFinal = resolve("/holon assign:r research -- sync back explicitly") as any
    expect(assignExplicitFinal?.kind).toBe("direct_execute")
    expect(assignExplicitFinal?.args).toEqual({ target: "research", mode: "final", content: "sync back explicitly" })
  })

  it("supports leader-led holon structure and assign commands", () => {
    const create = resolve("/holon create leader_led alpha") as any
    expect(create?.kind).toBe("direct_execute")
    expect(create?.namespace).toBe("holon")
    expect(create?.action).toBe("create")
    expect(create?.args).toEqual({ governance: "leader_led", name: "alpha" })

    const add = resolve("/holon add alpha alice") as any
    expect(add?.kind).toBe("direct_execute")
    expect(add?.action).toBe("add")
    expect(add?.args).toEqual({ holon: "alpha", member: "alice" })

    const appoint = resolve("/holon appoint alpha alice") as any
    expect(appoint?.kind).toBe("direct_execute")
    expect(appoint?.action).toBe("appoint")
    expect(appoint?.args).toEqual({ holon: "alpha", member: "alice" })

    const assignNone = resolve("/holon assign:n alpha -- take this over without replying") as any
    expect(assignNone?.kind).toBe("direct_execute")
    expect(assignNone?.action).toBe("assign")
    expect(assignNone?.args).toEqual({ target: "alpha", mode: "none", content: "take this over without replying" })

    const assignExplicitFinal = resolve("/holon assign:r alpha -- return an explicit final answer") as any
    expect(assignExplicitFinal?.kind).toBe("direct_execute")
    expect(assignExplicitFinal?.args).toEqual({ target: "alpha", mode: "final", content: "return an explicit final answer" })
  })

  it("rejects removed prompt namespace commands from the formal surface", () => {
    for (const input of [
      `${joinTokens("/", "bg")} list`,
      `${joinTokens("/", "te", "am")} list`,
      `${joinTokens("/", "pro", "tocol")} status req-1`,
      `${joinTokens("/", "auto", "nomy")} dispatch -- scan the project`,
    ]) {
      expect(resolve(input)).toBeNull()
    }
  })

  it("returns null for unrelated input", () => {
    expect(resolve("hello")).toBeNull()
    expect(resolve("/unknown")).toBeNull()
  })

  it("lets descriptor-driven slash contracts remove actions from help and prompt expansion", () => {
    const help = getSlashNamespaceHelp("member", CUSTOM_MEMBER_SLASH_COMMANDS)
    expect(help).toContain("/member catalog")
    expect(help).not.toContain("/member list")

    const prompt = expandSlashPrompt("/member list", CUSTOM_MEMBER_SLASH_COMMANDS)
    expect(prompt?.prompt).toContain("create, status, assign, assign:r, assign:n, assign:s, catalog")
    expect(prompt?.prompt).not.toContain("list")
  })

  it("lets descriptor-driven slash contracts add new direct actions", () => {
    const catalog = resolveSlashCommand("/member catalog", CUSTOM_MEMBER_SLASH_COMMANDS) as any
    expect(catalog?.kind).toBe("direct_execute")
    expect(catalog?.namespace).toBe("member")
    expect(catalog?.action).toBe("catalog")
    expect(catalog?.args).toEqual({})
  })
})
