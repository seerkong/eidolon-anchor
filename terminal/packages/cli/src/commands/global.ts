import { installBundledSystemSkills, resolveEidolonGlobalRoot } from "@cell/ai-support/system-skill/SystemSkillInstaller";
import type { CommandModule } from "yargs";

type GlobalArgs = {
  root?: string;
  json?: boolean;
};

export type GlobalCommandDeps = {
  stdout: Pick<NodeJS.WriteStream, "write">;
};

export function createGlobalCommand(
  deps: GlobalCommandDeps = { stdout: process.stdout },
): CommandModule<object, GlobalArgs> {
  return {
    command: "global <command>",
    describe: "manage Eidolon global assets",
    builder: (command) => command.command({
      command: "init",
      describe: "initialize or replace bundled system skills",
      builder: (init) => init
        .option("root", {
          type: "string",
          default: resolveEidolonGlobalRoot(),
          describe: "Eidolon global directory",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "write a machine-readable result",
        }),
      handler: async (args) => {
        const result = await installBundledSystemSkills({ globalRoot: String(args.root) });
        if (args.json) {
          deps.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }
        const installed = result.managed
          .map((skill) => `${skill.name}@${skill.version} (${skill.source}, ${skill.digest})`)
          .join(", ");
        deps.stdout.write(`Initialized ${installed} under ${result.skillsRoot}\n`);
      },
    }).demandCommand(1),
    handler: () => undefined,
  };
}

export const globalCommand = createGlobalCommand();
