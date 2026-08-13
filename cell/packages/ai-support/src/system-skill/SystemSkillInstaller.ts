import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";

import type { SkillEntry } from "@cell/ai-core-contract/runtime/SkillCatalog";

import { loadSkillEntriesFromDir } from "../skill/LocalFileSkillCatalog";
import { BUNDLED_SYSTEM_SKILLS, type BundledSystemSkill } from "./BundledSystemSkillCatalog";

export const SYSTEM_SKILL_MANIFEST_FILE = ".system-skills.xnl";

export type InstallBundledSystemSkillsResult = {
  kind: "eidolon.globalInitResult";
  globalRoot: string;
  skillsRoot: string;
  manifestPath: string;
  installed: string[];
};

export function resolveEidolonGlobalRoot(explicitRoot?: string): string {
  return path.resolve(explicitRoot ?? process.env.EIDOLON_GLOBAL_DIR ?? path.join(homedir(), ".eidolon"));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

export function resolveEidolonGlobalRootFromOuterContext(outerCtx: unknown): string {
  const context = asRecord(outerCtx);
  const metadata = asRecord(context?.metadata);
  const aiWorkflow = asRecord(metadata?.aiWorkflow);
  const roots = asRecord(aiWorkflow?.roots);
  const localPermissions = asRecord(metadata?.local_permissions) ?? asRecord(metadata?.localPermissions);
  const authorityRoot = typeof localPermissions?.authority_root === "string"
    ? localPermissions.authority_root
    : typeof localPermissions?.authorityRoot === "string"
      ? localPermissions.authorityRoot
      : undefined;
  // `aiWorkflow.roots.globalRoot` is the depa-flows global workflow resource
  // root (normally ~/.eidolon/workflows). System skills live at the Eidolon
  // authority root itself (normally ~/.eidolon/skills), so the permission
  // authority must win when both are present in a terminal runtime.
  const configured = (typeof roots?.systemRoot === "string" ? roots.systemRoot : undefined)
    ?? authorityRoot
    ?? (typeof roots?.globalRoot === "string" ? roots.globalRoot : undefined);
  return resolveEidolonGlobalRoot(configured);
}

function digestFiles(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const [relative, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(relative);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function assertValidSystemSkill(skill: BundledSystemSkill): void {
  if (!/^sys-[a-z0-9-]+$/.test(skill.name)) {
    throw new Error(`Bundled system skill has invalid identity: ${skill.name}`);
  }
  const root = skill.files["SKILL.md"];
  if (!root?.includes(`name: ${skill.name}`) || !root.includes("system: true")) {
    throw new Error(`Bundled system skill ${skill.name} has an invalid SKILL.md`);
  }
  for (const required of ["system-skill.xnl", "planning/system.md", "coding/system.md"]) {
    if (!skill.files[required]) throw new Error(`Bundled system skill ${skill.name} is missing ${required}`);
  }
}

async function writeSkillTree(root: string, skill: BundledSystemSkill): Promise<void> {
  for (const [relative, content] of Object.entries(skill.files)) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
}

async function replaceDirectoryAtomically(staged: string, target: string): Promise<void> {
  const backup = `${target}.backup-${process.pid}-${Date.now()}`;
  let movedExisting = false;
  try {
    await rename(target, backup);
    movedExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    await rename(staged, target);
    if (movedExisting) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (movedExisting) await rename(backup, target);
    throw error;
  }
}

function createManifest(skills: readonly BundledSystemSkill[]): string {
  const entries = skills.map((skill) => [
    "    <SystemSkill>",
    `      <Name>${skill.name}</Name>`,
    `      <Version>${skill.version}</Version>`,
    `      <Digest>${digestFiles(skill.files)}</Digest>`,
    "      <Authority>global-only</Authority>",
    "    </SystemSkill>",
  ].join("\n")).join("\n");
  return [
    '<SystemSkillsManifest xmlns="urn:eidolon:system-skills:v1">',
    "  <ManagedSkills>",
    entries,
    "  </ManagedSkills>",
    "</SystemSkillsManifest>",
    "",
  ].join("\n");
}

export async function installBundledSystemSkills(input: {
  globalRoot?: string;
} = {}): Promise<InstallBundledSystemSkillsResult> {
  const globalRoot = resolveEidolonGlobalRoot(input.globalRoot);
  const skillsRoot = path.join(globalRoot, "skills");
  await mkdir(skillsRoot, { recursive: true });

  for (const skill of BUNDLED_SYSTEM_SKILLS) {
    assertValidSystemSkill(skill);
    const stagingRoot = await mkdtemp(path.join(skillsRoot, `.${skill.name}.staging-`));
    try {
      await writeSkillTree(stagingRoot, skill);
      await replaceDirectoryAtomically(stagingRoot, path.join(skillsRoot, skill.name));
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  const manifestPath = path.join(skillsRoot, SYSTEM_SKILL_MANIFEST_FILE);
  const manifestTemp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(manifestTemp, createManifest(BUNDLED_SYSTEM_SKILLS), "utf8");
  await rename(manifestTemp, manifestPath);

  return {
    kind: "eidolon.globalInitResult",
    globalRoot,
    skillsRoot,
    manifestPath,
    installed: BUNDLED_SYSTEM_SKILLS.map((skill) => skill.name),
  };
}

function requireCanonicalSystemSkills(
  entries: Record<string, SkillEntry>,
  globalRoot: string,
): void {
  for (const bundled of BUNDLED_SYSTEM_SKILLS) {
    const entry = entries[bundled.name];
    if (!entry) {
      throw new Error(
        `Required system skill ${bundled.name}@${bundled.version} is missing under ${path.join(globalRoot, "skills")}; run \`eidolon global init\`.`,
      );
    }
    const identityPath = path.join(globalRoot, "skills", bundled.name, "system-skill.xnl");
    let identity: string;
    try {
      identity = readFileSync(identityPath, "utf8");
    } catch {
      throw new Error(`Required system skill ${bundled.name} has no readable system-skill.xnl; run \`eidolon global init\`.`);
    }
    if (!identity.includes(`name="${bundled.name}"`) || !identity.includes(`version="${bundled.version}"`)) {
      throw new Error(
        `Required system skill ${bundled.name} version conflicts with bundled ${bundled.version}; run \`eidolon global init\`.`,
      );
    }
  }
}

export function loadSkillEntriesWithSystemAuthority(input: {
  globalRoot?: string;
  workspaceRoot: string;
  requireSystemSkills?: boolean;
}): Record<string, SkillEntry> {
  const globalRoot = resolveEidolonGlobalRoot(input.globalRoot);
  const globalEntries = loadSkillEntriesFromDir(path.join(globalRoot, "skills"));
  if (input.requireSystemSkills) requireCanonicalSystemSkills(globalEntries, globalRoot);

  const workspaceEntries = loadSkillEntriesFromDir(path.join(input.workspaceRoot, ".eidolon", "skills"));
  const ordinaryWorkspaceEntries = Object.fromEntries(
    Object.entries(workspaceEntries).filter(([name]) => !name.startsWith("sys-")),
  );
  return { ...globalEntries, ...ordinaryWorkspaceEntries };
}

export async function readInstalledSystemSkillResource(input: {
  globalRoot?: string;
  skillName: string;
  relativePath: string;
}): Promise<string> {
  if (!input.skillName.startsWith("sys-")) throw new Error("Only system skill resources can be read here");
  const globalRoot = resolveEidolonGlobalRoot(input.globalRoot);
  const bundled = BUNDLED_SYSTEM_SKILLS.find((entry) => entry.name === input.skillName);
  if (bundled) {
    const identity = await readFile(path.join(globalRoot, "skills", input.skillName, "system-skill.xnl"), "utf8");
    if (!identity.includes(`name="${bundled.name}"`) || !identity.includes(`version="${bundled.version}"`)) {
      throw new Error(`System skill ${bundled.name} must be ${bundled.version}; run \`eidolon global init\`.`);
    }
  }
  const absolute = path.join(globalRoot, "skills", input.skillName, input.relativePath);
  return readFile(absolute, "utf8");
}

export const AI_WORKFLOW_STAGE_IDS = [
  "planning",
  "coding",
  "building",
  "testing",
  "releasing",
  "deploying",
  "operating",
  "monitoring",
] as const;

export type AiWorkflowStageId = typeof AI_WORKFLOW_STAGE_IDS[number];

async function listFilesRecursively(root: string, current = root): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursively(root, absolute));
    else files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files.sort();
}

export async function loadAiWorkflowStageContext(input: {
  globalRoot?: string;
  stage: AiWorkflowStageId;
}): Promise<string> {
  if (!AI_WORKFLOW_STAGE_IDS.includes(input.stage)) {
    throw new Error(`Unknown AI Workflow stage: ${input.stage}`);
  }
  const globalRoot = resolveEidolonGlobalRoot(input.globalRoot);
  const skillRoot = path.join(globalRoot, "skills", "sys-ai-workflow");
  await readInstalledSystemSkillResource({
    globalRoot,
    skillName: "sys-ai-workflow",
    relativePath: "SKILL.md",
  });
  const relativePaths = [`${input.stage}/system.md`, `${input.stage}/protocol.md`];
  if (input.stage === "coding") {
    relativePaths.push("coding/generation-kernel.md", "coding/workspace.md");
    const referenceRoot = path.join(skillRoot, "coding", "flow-dsl");
    for (const relative of await listFilesRecursively(referenceRoot)) {
      relativePaths.push(`coding/flow-dsl/${relative}`);
    }
  }
  const sections = await Promise.all(relativePaths.map(async (relative) => {
    const content = await readFile(path.join(skillRoot, relative), "utf8");
    return `<!-- sys-ai-workflow/${relative} -->\n${content.trim()}`;
  }));
  return sections.join("\n\n");
}
