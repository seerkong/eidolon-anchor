import type {
  RuntimeSlashCommandDescriptor,
  RuntimeSlashCommandNamespace,
} from "@cell/ai-core-contract";

export const DEFAULT_KERNEL_SLASH_COMMAND_SURFACES = [
  "/actor",
  "/member",
  "/holon",
];

export function mergeSlashCommandDescriptors(
  commands: RuntimeSlashCommandDescriptor[],
): RuntimeSlashCommandDescriptor[] {
  const merged = new Map<RuntimeSlashCommandNamespace, RuntimeSlashCommandDescriptor>();

  for (const command of commands) {
    const current = merged.get(command.namespace);
    if (!current) {
      merged.set(command.namespace, {
        namespace: command.namespace,
        actions: { ...command.actions },
      });
      continue;
    }

    merged.set(command.namespace, {
      namespace: command.namespace,
      actions: {
        ...current.actions,
        ...command.actions,
      },
    });
  }

  return Array.from(merged.values());
}

export function createKernelSlashCommandDescriptors(): RuntimeSlashCommandDescriptor[] {
  return [
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
        create: {
          toolName: "MemberCreate",
          parse: { kind: "create_member", form: "create", defaultAgentType: "code" },
          help: "`/member create <name> [@agent_name] [-- <prompt>]` Create a member",
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
        status: {
          toolName: "HolonStatus",
          parse: { kind: "target", form: "status", argName: "target" },
          help: "`/holon status <target>` Show holon status",
        },
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
      },
    },
  ];
}
