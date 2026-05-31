/**
 * CLI replay command — simple session trace/scene replay tool.
 *
 * Usage: bun run replay.ts <rootDir> <sessionId>
 *
 * Reads scenes/{sessionId}/manifest.xnl + events.xnl and prints a
 * human-readable turn-by-turn replay to stdout.
 */

import { parseArgs } from "node:util";
import { SceneStore } from "../SceneStore";
import { SceneReplay } from "../SceneReplay";

async function main() {
  const { positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
  });

  if (positionals.length < 2) {
    console.error("Usage: replay <rootDir> <sessionId>");
    process.exit(1);
  }

  const [rootDir, sessionId] = positionals;
  const store = new SceneStore(rootDir);
  const replay = new SceneReplay({ store });

  const { manifest, turns } = await replay.loadTurns(sessionId);

  if (manifest) {
    console.log("═══ Manifest ═══");
    console.log(`Session: ${manifest.sessionId}`);
    console.log(`Created: ${new Date(manifest.createdAt).toISOString()}`);
    console.log(`System:  ${manifest.systemPrompt.slice(0, 120)}${manifest.systemPrompt.length > 120 ? "…" : ""}`);
    if (manifest.toolDefs.length > 0) {
      console.log(`Tools:   ${manifest.toolDefs.map((t) => t.name).join(", ")}`);
    }
    console.log("");
  }

  if (turns.length === 0) {
    console.log("(no turns recorded)");
    process.exit(0);
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
}

main().catch((err) => {
  console.error("Replay error:", err);
  process.exit(2);
});
