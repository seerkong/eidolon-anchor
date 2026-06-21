import type { RuntimeAssemblyContext } from "@cell/ai-composer/ai-contract";
import fs from "fs";
import path from "path";
import {
  buildBundledDelegateGuidanceSection,
  buildBundledPrimaryPromptSection,
} from "../agent";

export function buildModAiCodingPromptSection(context: Pick<RuntimeAssemblyContext, "workDir">): string {
  return buildBundledPrimaryPromptSection({ workDir: context.workDir });
}

export function buildModAiCodingDelegateGuidanceSection(
  agentConfigs: Parameters<typeof buildBundledDelegateGuidanceSection>[0],
): string {
  return buildBundledDelegateGuidanceSection(agentConfigs);
}

export function loadWorkspaceAgentsPromptSection(workDir: string): string | null {
  try {
    const agentsPath = path.join(workDir, "AGENTS.md");
    if (!fs.existsSync(agentsPath) || !fs.statSync(agentsPath).isFile()) return null;
    const content = fs.readFileSync(agentsPath, "utf-8").trim();
    if (!content) return null;
    return `AGENTS.md (workspace):\n${content}`;
  } catch {
    return null;
  }
}
