import type { CommandModule } from "yargs";
import { SceneStore, SceneReplay } from "@terminal/organ/observability";
import { resolveProjectWorkDir } from "../../../organ-support/src";

type ReplayArgs = {
  project?: string;
  session?: string;
};

export const replay: CommandModule<object, ReplayArgs> = {
  command: "replay [project]",
  describe: "replay a recorded scene session turn-by-turn",
  builder: (yargs) =>
    yargs
      .positional("project", {
        type: "string",
        describe: "path to the project directory",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        demandOption: true,
        describe: "session id to replay",
      }),
  handler: async (args) => {
    const launchCwd = process.env.PWD ?? process.env.INIT_CWD ?? process.cwd();
    const workDir = resolveProjectWorkDir(launchCwd, args.project);

    const store = new SceneStore(workDir);
    const replay = new SceneReplay({ store });
    const { manifest, turns } = await replay.loadTurns(args.session!);

    if (manifest) {
      console.log("═══ Manifest ═══");
      console.log(`Session: ${manifest.sessionId}`);
      console.log(`Created: ${new Date(manifest.createdAt).toISOString()}`);
      const sys = manifest.systemPrompt.slice(0, 120);
      console.log(`System:  ${sys}${manifest.systemPrompt.length > 120 ? "…" : ""}`);
      if (manifest.toolDefs.length > 0) {
        console.log(`Tools:   ${manifest.toolDefs.map((t) => t.name).join(", ")}`);
      }
      console.log("");
    }

    if (turns.length === 0) {
      console.log("(no turns recorded)");
      return;
    }

    for (const turn of turns) {
      console.log(`─── Turn ${turn.turnIndex} ───`);
      console.log(`User: ${turn.userMessage.textParts.join("\n")}`);

      if (turn.recordedAssistant) {
        console.log(`Assistant: ${turn.recordedAssistant.textParts.join("\n")}`);
        if (turn.recordedAssistant.toolCalls?.length) {
          for (const tc of turn.recordedAssistant.toolCalls) {
            console.log(`  🔧 ${tc.name}(${JSON.stringify(tc.args)})`);
          }
        }
      } else {
        console.log("Assistant: (no response recorded)");
      }
      console.log("");
    }

    console.log(`Total: ${turns.length} turns`);
  },
};
