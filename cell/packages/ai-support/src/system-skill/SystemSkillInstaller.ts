import { homedir } from "node:os";
import path from "node:path";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";

import type { SkillEntry } from "@cell/ai-core-contract/runtime/SkillCatalog";
import {
  applySkillCapsuleDistributionPlan,
  type SkillCapsuleDistributionPlan,
} from "halfcode-compiler.xnl";
import { sha256Digest, type Sha256Digest } from "halfcode-compiler.xnl/resource-core";
import { safePathLexicalIssue } from "halfcode-compiler.xnl/resource-mapping";
import { parseXnl } from "xnl-core";

import { loadSkillEntriesFromDir, loadSkillEntryFromSkillDir } from "../skill/LocalFileSkillCatalog";
import {
  EXPECTED_EIDOLON_SYSTEM_SKILL_SET,
  loadEidolonSystemSkillDistributionPlan,
} from "./GeneratedEidolonSystemSkillPlan";

export const SYSTEM_SKILL_MANIFEST_FILE = ".system-skills.xnl";
const SYSTEM_SKILL_MANIFEST_SCHEMA = "eidolon.system-skills/v2";

export type ManagedSystemSkillSource = "eidolon-builtin" | "halfcode-distribution";

export type ManagedSystemSkillSummary = {
  name: string;
  version: string;
  source: ManagedSystemSkillSource;
  digest: Sha256Digest;
  fileCount: number;
  capsuleFqn?: string;
  apiVersion?: string;
  closureDigest?: string;
};

export type InstalledSystemSkillFile = {
  path: string;
  digest: Sha256Digest;
};

export type InstalledSystemSkill = ManagedSystemSkillSummary & {
  files: readonly InstalledSystemSkillFile[];
};

export type InstalledSystemSkillManifest = {
  schemaVersion: typeof SYSTEM_SKILL_MANIFEST_SCHEMA;
  managed: readonly ManagedSystemSkillSummary[];
  skills: readonly InstalledSystemSkill[];
};

export type InstallSystemSkillStep =
  | "after-halfcode-apply"
  | "after-candidate-readback"
  | "after-backup"
  | "after-live-rename"
  | "after-live-readback"
  | "before-backup-cleanup";

export type InstallBundledSystemSkillsResult = {
  kind: "eidolon.globalInitResult";
  globalRoot: string;
  skillsRoot: string;
  manifestPath: string;
  installed: string[];
  managed: readonly ManagedSystemSkillSummary[];
};

type MaterializedSystemSkill = InstalledSystemSkill & {
  fileContents: ReadonlyMap<string, Uint8Array>;
};

type XnlNode = {
  kind?: string;
  tag?: string;
  attributes?: Record<string, unknown>;
  body?: unknown[];
  extend?: { children?: Record<string, XnlNode> };
};

class SystemSkillTransactionError extends Error {
  constructor(message: string, readonly causes: readonly unknown[]) {
    super(message);
    this.name = "SystemSkillTransactionError";
  }
}

function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

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
  const configured = (typeof roots?.systemRoot === "string" ? roots.systemRoot : undefined)
    ?? authorityRoot
    ?? (typeof roots?.globalRoot === "string" ? roots.globalRoot : undefined);
  return resolveEidolonGlobalRoot(configured);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  if (typeof value !== "string" || value.length !== 71 || !value.startsWith("sha256:")) return false;
  for (const character of value.slice(7)) {
    if (!((character >= "0" && character <= "9") || (character >= "a" && character <= "f"))) return false;
  }
  return true;
}

function assertSafeRelativeFilePath(relativePath: string, owner: string): void {
  const issue = safePathLexicalIssue(relativePath, "relative-path");
  if (issue) throw new Error(`SYSTEM_SKILL_PATH_INVALID: ${owner} path ${JSON.stringify(relativePath)} ${issue}`);
}

function assertSystemSkillName(name: string): void {
  const suffix = name.startsWith("sys-") ? name.slice(4) : "";
  const valid = suffix.length > 0 && [...suffix].every((character) =>
    (character >= "a" && character <= "z")
    || (character >= "0" && character <= "9")
    || character === "-"
  );
  if (!valid) {
    throw new Error(`SYSTEM_SKILL_IDENTITY_INVALID: invalid managed system Skill identity ${JSON.stringify(name)}`);
  }
}

function digestFiles(files: readonly InstalledSystemSkillFile[]): Sha256Digest {
  return sha256Digest(files.map((file) => `${file.path}\0${file.digest}\0`).join(""));
}

function materializedSkill(input: {
  name: string;
  version: string;
  source: ManagedSystemSkillSource;
  files: ReadonlyMap<string, Uint8Array>;
  capsuleFqn?: string;
  apiVersion?: string;
  closureDigest?: string;
}): MaterializedSystemSkill {
  assertSystemSkillName(input.name);
  const files = [...input.files.entries()]
    .map(([filePath, content]) => {
      assertSafeRelativeFilePath(filePath, input.name);
      return Object.freeze({ path: filePath, digest: sha256Digest(content) });
    })
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  if (files.length === 0) throw new Error(`SYSTEM_SKILL_FILES_MISSING: ${input.name} has no files`);
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new Error(`SYSTEM_SKILL_FILES_MISSING: ${input.name} has no SKILL.md`);
  }
  return Object.freeze({
    name: input.name,
    version: input.version,
    source: input.source,
    digest: digestFiles(files),
    fileCount: files.length,
    ...(input.capsuleFqn ? { capsuleFqn: input.capsuleFqn } : {}),
    ...(input.apiVersion ? { apiVersion: input.apiVersion } : {}),
    ...(input.closureDigest ? { closureDigest: input.closureDigest } : {}),
    files: Object.freeze(files),
    fileContents: new Map([...input.files.entries()].map(([filePath, content]) => [filePath, Uint8Array.from(content)])),
  });
}

async function listFilesRecursively(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) files.push(...await listFilesRecursively(root, absolute));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`SYSTEM_SKILL_OUTPUT_INVALID: generated output contains non-file ${JSON.stringify(relative)}`);
  }
  return files.sort(compareCodeUnits);
}

function planIdentityMap(plan: SkillCapsuleDistributionPlan): ReadonlyMap<string, SkillCapsuleDistributionPlan["capsules"][number]["identity"]> {
  const identities = new Map<string, SkillCapsuleDistributionPlan["capsules"][number]["identity"]>();
  for (const capsule of plan.capsules) {
    if (identities.has(capsule.identity.fqn)) {
      throw new Error(`SYSTEM_SKILL_PLAN_INVALID: duplicate capsule ${capsule.identity.fqn}`);
    }
    identities.set(capsule.identity.fqn, capsule.identity);
  }
  return identities;
}

async function materializeEidolonSystemSkills(input: {
  outputRoot: string;
  onStep?: (step: InstallSystemSkillStep) => void | Promise<void>;
}): Promise<readonly MaterializedSystemSkill[]> {
  const plan = loadEidolonSystemSkillDistributionPlan();
  const receipt = await applySkillCapsuleDistributionPlan(plan, { outputRoot: input.outputRoot });
  if (receipt.closureDigest !== plan.closureDigest) {
    throw new Error("SYSTEM_SKILL_PLAN_READBACK_INVALID: Halfcode receipt closure digest differs from the plan");
  }
  const actualFiles = await listFilesRecursively(input.outputRoot);
  const expectedFiles = plan.files.map((file) => file.targetRelativePath).sort(compareCodeUnits);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)
    || JSON.stringify(receipt.files) !== JSON.stringify(expectedFiles)) {
    throw new Error("SYSTEM_SKILL_PLAN_READBACK_INVALID: Halfcode output files differ from the plan");
  }

  const identities = planIdentityMap(plan);
  const groupedFiles = new Map<string, Map<string, Uint8Array>>();
  for (const plannedFile of plan.files) {
    const identity = identities.get(plannedFile.skillFqn);
    if (!identity) throw new Error(`SYSTEM_SKILL_PLAN_INVALID: missing identity for ${plannedFile.skillFqn}`);
    const prefix = `${identity.name}/`;
    if (!plannedFile.targetRelativePath.startsWith(prefix)) {
      throw new Error(`SYSTEM_SKILL_PLAN_INVALID: target ${plannedFile.targetRelativePath} is outside ${identity.name}`);
    }
    const relative = plannedFile.targetRelativePath.slice(prefix.length);
    assertSafeRelativeFilePath(relative, identity.name);
    const bytes = new Uint8Array(await readFile(path.join(input.outputRoot, plannedFile.targetRelativePath)));
    if (sha256Digest(bytes) !== plannedFile.contentDigest
      || !Buffer.from(bytes).equals(Buffer.from(plannedFile.contentBase64, "base64"))) {
      throw new Error(`SYSTEM_SKILL_PLAN_READBACK_INVALID: content differs for ${plannedFile.targetRelativePath}`);
    }
    const files = groupedFiles.get(identity.fqn) ?? new Map<string, Uint8Array>();
    if (files.has(relative)) throw new Error(`SYSTEM_SKILL_PLAN_INVALID: duplicate file ${plannedFile.targetRelativePath}`);
    files.set(relative, bytes);
    groupedFiles.set(identity.fqn, files);
  }

  const receiptIdentities = receipt.installedSkills.map((identity) => identity.fqn);
  if (JSON.stringify(receiptIdentities) !== JSON.stringify(plan.topology)) {
    throw new Error("SYSTEM_SKILL_PLAN_READBACK_INVALID: installed identities differ from plan topology");
  }
  const skills = plan.topology.map((fqn) => {
    const identity = identities.get(fqn);
    const files = groupedFiles.get(fqn);
    if (!identity || !files) throw new Error(`SYSTEM_SKILL_PLAN_INVALID: incomplete capsule ${fqn}`);
    return materializedSkill({
      name: identity.name,
      version: identity.version,
      source: "halfcode-distribution",
      files,
      capsuleFqn: identity.fqn,
      apiVersion: identity.apiVersion,
      closureDigest: plan.closureDigest,
    });
  });
  await input.onStep?.("after-halfcode-apply");
  return Object.freeze(skills);
}

function summaryOf(skill: InstalledSystemSkill): ManagedSystemSkillSummary {
  return Object.freeze({
    name: skill.name,
    version: skill.version,
    source: skill.source,
    digest: skill.digest,
    fileCount: skill.fileCount,
    ...(skill.capsuleFqn ? { capsuleFqn: skill.capsuleFqn } : {}),
    ...(skill.apiVersion ? { apiVersion: skill.apiVersion } : {}),
    ...(skill.closureDigest ? { closureDigest: skill.closureDigest } : {}),
  });
}

function quoteXnl(value: string): string {
  return JSON.stringify(value);
}

function createManifest(skills: readonly InstalledSystemSkill[]): string {
  const entries = skills.map((skill) => {
    const optional = [
      skill.capsuleFqn ? ` capsuleFqn = ${quoteXnl(skill.capsuleFqn)}` : "",
      skill.apiVersion ? ` apiVersion = ${quoteXnl(skill.apiVersion)}` : "",
      skill.closureDigest ? ` closureDigest = ${quoteXnl(skill.closureDigest)}` : "",
    ].join("");
    const files = skill.files.map((file) =>
      `        <File { path = ${quoteXnl(file.path)} digest = ${quoteXnl(file.digest)} }>`).join("\n");
    return [
      `    <SystemSkill { name = ${quoteXnl(skill.name)} version = ${quoteXnl(skill.version)} source = ${quoteXnl(skill.source)} digest = ${quoteXnl(skill.digest)} fileCount = ${skill.fileCount}${optional} } (`,
      "      <Files [",
      files,
      "      ]>",
      "    )>",
    ].join("\n");
  }).join("\n");
  return [
    `<SystemSkillsManifest { schemaVersion = ${quoteXnl(SYSTEM_SKILL_MANIFEST_SCHEMA)} } (`,
    "  <ManagedSkills [",
    entries,
    "  ]>",
    ")>",
    "",
  ].join("\n");
}

function expectAttributes(node: XnlNode, owner: string, allowed: readonly string[]): Record<string, unknown> {
  const attributes = node.attributes;
  if (!attributes) throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${owner} has no attributes`);
  const unexpected = Object.keys(attributes).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${owner} has unsupported attributes ${unexpected.join(", ")}`);
  }
  return attributes;
}

function requireString(attributes: Record<string, unknown>, field: string, owner: string): string {
  const value = attributes[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${owner}.${field} must be a non-empty string`);
  }
  return value;
}

function parseManifest(source: string): InstalledSystemSkillManifest {
  let document: ReturnType<typeof parseXnl>;
  try {
    document = parseXnl(source);
  } catch (error) {
    throw errorWithCause("SYSTEM_SKILL_MANIFEST_INVALID: manifest is not valid XNL", error);
  }
  if ((document.warnings?.length ?? 0) > 0 || document.nodes.length !== 1) {
    throw new Error("SYSTEM_SKILL_MANIFEST_INVALID: manifest must contain one warning-free root");
  }
  const root = document.nodes[0] as XnlNode;
  if (root.tag !== "SystemSkillsManifest") {
    throw new Error("SYSTEM_SKILL_MANIFEST_INVALID: root must be SystemSkillsManifest");
  }
  const rootAttributes = expectAttributes(root, "SystemSkillsManifest", ["schemaVersion"]);
  if (rootAttributes.schemaVersion !== SYSTEM_SKILL_MANIFEST_SCHEMA) {
    throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: unsupported schema ${String(rootAttributes.schemaVersion)}`);
  }
  const managedNode = root.extend?.children?.ManagedSkills;
  if (!managedNode || !Array.isArray(managedNode.body)) {
    throw new Error("SYSTEM_SKILL_MANIFEST_INVALID: ManagedSkills must be a body list");
  }

  const names = new Set<string>();
  const skills = managedNode.body.map((value, index): InstalledSystemSkill => {
    const node = value as XnlNode;
    if (node?.tag !== "SystemSkill") {
      throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ManagedSkills[${index}] must be SystemSkill`);
    }
    const owner = `ManagedSkills[${index}]`;
    const attributes = expectAttributes(node, owner, [
      "name", "version", "source", "digest", "fileCount", "capsuleFqn", "apiVersion", "closureDigest",
    ]);
    const name = requireString(attributes, "name", owner);
    assertSystemSkillName(name);
    if (names.has(name)) throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: duplicate identity ${name}`);
    names.add(name);
    const source = requireString(attributes, "source", owner);
    if (source !== "eidolon-builtin" && source !== "halfcode-distribution") {
      throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: unsupported source ${source}`);
    }
    const digest = attributes.digest;
    if (!isSha256Digest(digest)) throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${name} has invalid digest`);
    const fileCount = attributes.fileCount;
    if (!Number.isSafeInteger(fileCount) || (fileCount as number) <= 0) {
      throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${name} has invalid fileCount`);
    }
    const filesNode = node.extend?.children?.Files;
    if (!filesNode || !Array.isArray(filesNode.body)) {
      throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${name} has no Files list`);
    }
    const paths = new Set<string>();
    const files = filesNode.body.map((fileValue, fileIndex): InstalledSystemSkillFile => {
      const fileNode = fileValue as XnlNode;
      if (fileNode?.tag !== "File") {
        throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${name}.Files[${fileIndex}] must be File`);
      }
      const fileAttributes = expectAttributes(fileNode, `${name}.Files[${fileIndex}]`, ["path", "digest"]);
      const filePath = requireString(fileAttributes, "path", `${name}.Files[${fileIndex}]`);
      assertSafeRelativeFilePath(filePath, name);
      if (paths.has(filePath)) throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${name} has duplicate path ${filePath}`);
      paths.add(filePath);
      const fileDigest = fileAttributes.digest;
      if (!isSha256Digest(fileDigest)) {
        throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${name}.${filePath} has invalid digest`);
      }
      return Object.freeze({ path: filePath, digest: fileDigest });
    });
    if (files.length !== fileCount) {
      throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${name} fileCount differs from Files`);
    }
    files.sort((left, right) => compareCodeUnits(left.path, right.path));
    if (digestFiles(files) !== digest) {
      throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${name} skill digest differs from Files`);
    }
    const optionalString = (field: "capsuleFqn" | "apiVersion" | "closureDigest"): string | undefined => {
      const candidate = attributes[field];
      if (candidate === undefined) return undefined;
      if (typeof candidate !== "string" || candidate.length === 0) {
        throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${name}.${field} must be a non-empty string`);
      }
      return candidate;
    };
    const capsuleFqn = optionalString("capsuleFqn");
    const apiVersion = optionalString("apiVersion");
    const closureDigest = optionalString("closureDigest");
    return Object.freeze({
      name,
      version: requireString(attributes, "version", owner),
      source,
      digest,
      fileCount,
      ...(capsuleFqn ? { capsuleFqn } : {}),
      ...(apiVersion ? { apiVersion } : {}),
      ...(closureDigest ? { closureDigest } : {}),
      files: Object.freeze(files),
    });
  });
  if (skills.length === 0) throw new Error("SYSTEM_SKILL_MANIFEST_INVALID: managed set is empty");
  return Object.freeze({
    schemaVersion: SYSTEM_SKILL_MANIFEST_SCHEMA,
    managed: Object.freeze(skills.map(summaryOf)),
    skills: Object.freeze(skills),
  });
}

function assertExpectedManagedSystemSkillSet(manifest: InstalledSystemSkillManifest): void {
  const expectedProjection = EXPECTED_EIDOLON_SYSTEM_SKILL_SET.map((expected) => {
    const files = expected.files.map((file) => Object.freeze({
      path: file.path,
      digest: file.digest as Sha256Digest,
    }));
    return {
      name: expected.name,
      version: expected.version,
      source: "halfcode-distribution" as const,
      digest: digestFiles(files),
      fileCount: files.length,
      capsuleFqn: expected.capsuleFqn,
      apiVersion: expected.apiVersion,
      closureDigest: expected.closureDigest,
      files,
    };
  });
  const actualProjection = manifest.skills.map((skill) => ({
    name: skill.name,
    version: skill.version,
    source: skill.source,
    digest: skill.digest,
    fileCount: skill.fileCount,
    capsuleFqn: skill.capsuleFqn,
    apiVersion: skill.apiVersion,
    closureDigest: skill.closureDigest,
    files: skill.files,
  }));
  if (JSON.stringify(actualProjection) !== JSON.stringify(expectedProjection)) {
    throw new Error(
      "SYSTEM_SKILL_BUILD_MISMATCH: installed managed Skills do not match this Eidolon build; run `eidolon global init`.",
    );
  }
}

async function readManifestAtSkillsRoot(skillsRoot: string): Promise<InstalledSystemSkillManifest> {
  const skillsRootStat = await lstat(skillsRoot);
  if (!skillsRootStat.isDirectory() || skillsRootStat.isSymbolicLink()) {
    throw new Error(`SYSTEM_SKILL_ROOT_INVALID: ${skillsRoot} must be a physical directory`);
  }
  const manifestPath = path.join(skillsRoot, SYSTEM_SKILL_MANIFEST_FILE);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${manifestPath} must be a physical file`);
  }
  const realSkillsRoot = await realpath(skillsRoot);
  const realManifest = await realpath(manifestPath);
  if (!isWithin(realSkillsRoot, realManifest)) {
    throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${manifestPath} escapes the real skills root`);
  }
  return parseManifest(await readFile(realManifest, "utf8"));
}

export async function readInstalledSystemSkillManifest(input: {
  globalRoot?: string;
} = {}): Promise<InstalledSystemSkillManifest> {
  const globalRoot = resolveEidolonGlobalRoot(input.globalRoot);
  return readManifestAtSkillsRoot(path.join(globalRoot, "skills"));
}

async function writeSkillTree(root: string, skill: MaterializedSystemSkill): Promise<void> {
  const skillRoot = path.join(root, skill.name);
  for (const file of skill.files) {
    const content = skill.fileContents.get(file.path);
    if (!content) throw new Error(`SYSTEM_SKILL_MATERIALIZATION_INVALID: missing ${skill.name}/${file.path}`);
    const destination = path.join(skillRoot, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

async function copyOrdinaryAssets(input: {
  sourceRoot: string;
  candidateRoot: string;
  managedNames: ReadonlySet<string>;
}): Promise<void> {
  let sourceStat;
  try {
    sourceStat = await lstat(input.sourceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`SYSTEM_SKILL_ROOT_INVALID: ${input.sourceRoot} must be a physical directory`);
  }
  for (const entry of await readdir(input.sourceRoot, { withFileTypes: true })) {
    if (
      entry.name === SYSTEM_SKILL_MANIFEST_FILE
      || input.managedNames.has(entry.name)
      || entry.name.startsWith("sys-")
    ) continue;
    await cp(path.join(input.sourceRoot, entry.name), path.join(input.candidateRoot, entry.name), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    });
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function readManagedFile(
  skillsRoot: string,
  skill: InstalledSystemSkill,
  file: InstalledSystemSkillFile,
): Promise<Uint8Array> {
  const skillRoot = path.join(skillsRoot, skill.name);
  const skillsRootStat = await lstat(skillsRoot);
  if (!skillsRootStat.isDirectory() || skillsRootStat.isSymbolicLink()) {
    throw new Error(`SYSTEM_SKILL_ROOT_INVALID: ${skillsRoot} must be a physical directory`);
  }
  const skillRootStat = await lstat(skillRoot);
  if (!skillRootStat.isDirectory() || skillRootStat.isSymbolicLink()) {
    throw new Error(`SYSTEM_SKILL_ROOT_INVALID: ${skill.name} must be a physical directory`);
  }
  const lexicalPath = path.resolve(skillRoot, file.path);
  if (!isWithin(skillRoot, lexicalPath)) {
    throw new Error(`SYSTEM_SKILL_PATH_INVALID: ${skill.name}/${file.path} escapes its root`);
  }
  const fileStat = await lstat(lexicalPath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`SYSTEM_SKILL_FILE_INVALID: ${skill.name}/${file.path} must be a physical file`);
  }
  const realSkillsRoot = await realpath(skillsRoot);
  const realSkillRoot = await realpath(skillRoot);
  if (!isWithin(realSkillsRoot, realSkillRoot)) {
    throw new Error(`SYSTEM_SKILL_PATH_INVALID: ${skill.name} escapes the real skills root`);
  }
  const realFile = await realpath(lexicalPath);
  if (!isWithin(realSkillRoot, realFile)) {
    throw new Error(`SYSTEM_SKILL_PATH_INVALID: ${skill.name}/${file.path} escapes its real root`);
  }
  const content = new Uint8Array(await readFile(realFile));
  if (sha256Digest(content) !== file.digest) {
    throw new Error(`SYSTEM_SKILL_DIGEST_MISMATCH: ${skill.name}/${file.path} digest differs from manifest`);
  }
  return content;
}

async function assertInstalledTree(
  skillsRoot: string,
  expected?: readonly MaterializedSystemSkill[],
): Promise<InstalledSystemSkillManifest> {
  const manifest = await readManifestAtSkillsRoot(skillsRoot);
  if (expected) {
    const expectedProjection = expected.map((skill) => ({ ...summaryOf(skill), files: skill.files }));
    if (JSON.stringify(manifest.skills) !== JSON.stringify(expectedProjection)) {
      throw new Error("SYSTEM_SKILL_READBACK_INVALID: installed manifest differs from candidate projection");
    }
  }
  for (const skill of manifest.skills) {
    const actualFiles = await listFilesRecursively(path.join(skillsRoot, skill.name));
    const expectedFiles = skill.files.map((file) => file.path);
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(`SYSTEM_SKILL_READBACK_INVALID: ${skill.name} contains undeclared or missing files`);
    }
    for (const file of skill.files) await readManagedFile(skillsRoot, skill, file);
  }
  return manifest;
}

async function restorePreviousSkillsRoot(input: {
  skillsRoot: string;
  backupRoot: string;
  hadPrevious: boolean;
  candidateIsLive: boolean;
}): Promise<void> {
  let rejectedRoot: string | undefined;
  if (input.candidateIsLive) {
    rejectedRoot = path.join(
      path.dirname(input.skillsRoot),
      `.${path.basename(input.skillsRoot)}.rejected-${process.pid}-${Date.now()}`,
    );
    await rename(input.skillsRoot, rejectedRoot);
  }
  try {
    if (input.hadPrevious) await rename(input.backupRoot, input.skillsRoot);
  } catch (error) {
    throw new SystemSkillTransactionError(
      `SYSTEM_SKILL_RESTORE_FAILED: previous Skill tree remains at ${input.backupRoot}`,
      [error],
    );
  }
  if (rejectedRoot) await rm(rejectedRoot, { recursive: true, force: true });
}

async function replaceSkillsRoot(input: {
  candidateRoot: string;
  skillsRoot: string;
  expected: readonly MaterializedSystemSkill[];
  onStep?: (step: InstallSystemSkillStep) => void | Promise<void>;
}): Promise<InstalledSystemSkillManifest> {
  const backupRoot = path.join(
    path.dirname(input.skillsRoot),
    `.${path.basename(input.skillsRoot)}.backup-${process.pid}-${Date.now()}`,
  );
  let hadPrevious = false;
  let candidateIsLive = false;
  let installedManifest: InstalledSystemSkillManifest | undefined;
  try {
    await rename(input.skillsRoot, backupRoot);
    hadPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await input.onStep?.("after-backup");
    await rename(input.candidateRoot, input.skillsRoot);
    candidateIsLive = true;
    await input.onStep?.("after-live-rename");
    installedManifest = await assertInstalledTree(input.skillsRoot, input.expected);
    await input.onStep?.("after-live-readback");
  } catch (error) {
    try {
      await restorePreviousSkillsRoot({
        skillsRoot: input.skillsRoot,
        backupRoot,
        hadPrevious,
        candidateIsLive,
      });
    } catch (restoreError) {
      throw new SystemSkillTransactionError("SYSTEM_SKILL_TRANSACTION_AND_RESTORE_FAILED", [error, restoreError]);
    }
    throw error;
  }
  if (!installedManifest) {
    throw new Error("SYSTEM_SKILL_TRANSACTION_INVALID: live readback did not produce a manifest");
  }
  if (hadPrevious) {
    try {
      await input.onStep?.("before-backup-cleanup");
      await rm(backupRoot, { recursive: true, force: true });
    } catch (error) {
      throw new SystemSkillTransactionError(
        `SYSTEM_SKILL_BACKUP_CLEANUP_FAILED: verified live Skill tree remains at ${input.skillsRoot}; backup evidence remains at ${backupRoot}`,
        [error],
      );
    }
  }
  return installedManifest;
}

export async function installBundledSystemSkills(input: {
  globalRoot?: string;
  onStep?: (step: InstallSystemSkillStep) => void | Promise<void>;
} = {}): Promise<InstallBundledSystemSkillsResult> {
  const globalRoot = resolveEidolonGlobalRoot(input.globalRoot);
  const skillsRoot = path.join(globalRoot, "skills");
  await mkdir(globalRoot, { recursive: true });
  const workRoot = await mkdtemp(path.join(globalRoot, ".system-skills.work-"));
  const candidateRoot = await mkdtemp(path.join(globalRoot, ".skills.candidate-"));
  try {
    const managedSkills = await materializeEidolonSystemSkills({
      outputRoot: path.join(workRoot, "halfcode-output"),
      onStep: input.onStep,
    });
    const managedNames = new Set<string>();
    for (const skill of managedSkills) {
      if (managedNames.has(skill.name)) {
        throw new Error(`SYSTEM_SKILL_IDENTITY_COLLISION: duplicate managed identity ${skill.name}`);
      }
      managedNames.add(skill.name);
    }

    await copyOrdinaryAssets({ sourceRoot: skillsRoot, candidateRoot, managedNames });
    for (const skill of managedSkills) await writeSkillTree(candidateRoot, skill);
    await writeFile(path.join(candidateRoot, SYSTEM_SKILL_MANIFEST_FILE), createManifest(managedSkills), "utf8");
    await assertInstalledTree(candidateRoot, managedSkills);
    await input.onStep?.("after-candidate-readback");
    const installedManifest = await replaceSkillsRoot({
      candidateRoot,
      skillsRoot,
      expected: managedSkills,
      onStep: input.onStep,
    });
    return {
      kind: "eidolon.globalInitResult",
      globalRoot,
      skillsRoot,
      manifestPath: path.join(skillsRoot, SYSTEM_SKILL_MANIFEST_FILE),
      installed: installedManifest.managed.map((skill) => skill.name),
      managed: installedManifest.managed,
    };
  } finally {
    await rm(candidateRoot, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
  }
}

function readCanonicalSystemSkillManifest(globalRoot: string, required: boolean): InstalledSystemSkillManifest | undefined {
  const skillsRoot = path.join(globalRoot, "skills");
  let skillsRootStat;
  try {
    skillsRootStat = lstatSync(skillsRoot);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw errorWithCause("Required system Skill manifest is missing or invalid; run `eidolon global init`.", error);
  }
  if (!skillsRootStat.isDirectory() || skillsRootStat.isSymbolicLink()) {
    throw new Error(`SYSTEM_SKILL_ROOT_INVALID: ${skillsRoot} must be a physical directory`);
  }
  const manifestPath = path.join(skillsRoot, SYSTEM_SKILL_MANIFEST_FILE);
  let manifestStat;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw errorWithCause("Required system Skill manifest is missing or invalid; run `eidolon global init`.", error);
  }
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${manifestPath} must be a physical file`);
  }
  const realSkillsRoot = realpathSync(skillsRoot);
  const realManifest = realpathSync(manifestPath);
  if (!isWithin(realSkillsRoot, realManifest)) {
    throw new Error(`SYSTEM_SKILL_MANIFEST_INVALID: ${manifestPath} escapes the real skills root`);
  }
  try {
    return parseManifest(readFileSync(realManifest, "utf8"));
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw errorWithCause("Required system Skill manifest is missing or invalid; run `eidolon global init`.", error);
  }
}

function assertManagedSkillTreeSync(globalRoot: string, managed: InstalledSystemSkill): void {
  const skillsRoot = path.join(globalRoot, "skills");
  const skillRoot = path.join(skillsRoot, managed.name);
  const skillsRootStat = lstatSync(skillsRoot);
  const skillRootStat = lstatSync(skillRoot);
  if (!skillsRootStat.isDirectory() || skillsRootStat.isSymbolicLink()) {
    throw new Error(`Required system Skill root ${skillsRoot} must be a physical directory; run \`eidolon global init\`.`);
  }
  if (!skillRootStat.isDirectory() || skillRootStat.isSymbolicLink()) {
    throw new Error(`Required system Skill ${managed.name} must be a physical directory; run \`eidolon global init\`.`);
  }
  const realSkillsRoot = realpathSync(skillsRoot);
  const realSkillRoot = realpathSync(skillRoot);
  if (!isWithin(realSkillsRoot, realSkillRoot)) {
    throw new Error(`Required system Skill ${managed.name} escapes the real skills root; run \`eidolon global init\`.`);
  }
  const actualFiles: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(absolute);
      } else {
        actualFiles.push(path.relative(skillRoot, absolute).split(path.sep).join("/"));
      }
    }
  };
  visit(skillRoot);
  actualFiles.sort(compareCodeUnits);
  const expectedFiles = managed.files.map((file) => file.path);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Required system Skill ${managed.name} contains undeclared or missing files; run \`eidolon global init\`.`);
  }
  for (const file of managed.files) {
    const lexicalPath = path.resolve(skillRoot, file.path);
    const fileStat = lstatSync(lexicalPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`Required system Skill ${managed.name}/${file.path} must be a physical file; run \`eidolon global init\`.`);
    }
    const realFile = realpathSync(lexicalPath);
    if (!isWithin(realSkillRoot, realFile)) {
      throw new Error(`Required system Skill ${managed.name}/${file.path} escapes its real root; run \`eidolon global init\`.`);
    }
    if (sha256Digest(readFileSync(realFile)) !== file.digest) {
      const conflict = managed.source === "eidolon-builtin"
        ? "version conflicts with bundled evidence"
        : "digest conflicts with installed evidence";
      throw new Error(`Required system Skill ${managed.name} ${conflict}; run \`eidolon global init\`.`);
    }
  }
}

function requireCanonicalSystemSkills(
  entries: Record<string, SkillEntry>,
  globalRoot: string,
  manifest: InstalledSystemSkillManifest,
): void {
  for (const managed of manifest.skills) {
    if (!entries[managed.name]) {
      throw new Error(`Required system Skill ${managed.name}@${managed.version} is missing; run \`eidolon global init\`.`);
    }
    assertManagedSkillTreeSync(globalRoot, managed);
  }
}

export function loadSkillEntriesWithSystemAuthority(input: {
  globalRoot?: string;
  workspaceRoot: string;
  requireSystemSkills?: boolean;
}): Record<string, SkillEntry> {
  const globalRoot = resolveEidolonGlobalRoot(input.globalRoot);
  const skillsRoot = path.join(globalRoot, "skills");
  const manifest = readCanonicalSystemSkillManifest(globalRoot, input.requireSystemSkills === true);
  const globalEntries = loadSkillEntriesFromDir(skillsRoot, {
    includeDirectory: (name) => !name.startsWith("sys-"),
  });
  const authorizedGlobalEntries: Record<string, SkillEntry> = Object.fromEntries(
    Object.entries(globalEntries).filter(([name, entry]) => (
      !name.startsWith("sys-") && !path.basename(entry.dir).startsWith("sys-")
    )),
  );
  if (manifest) {
    assertExpectedManagedSystemSkillSet(manifest);
    const canonicalSystemEntries: Record<string, SkillEntry> = {};
    for (const managed of manifest.skills) {
      assertManagedSkillTreeSync(globalRoot, managed);
      const entry = loadSkillEntryFromSkillDir(path.join(skillsRoot, managed.name));
      if (!entry || entry.name !== managed.name) {
        throw new Error(`Required system Skill ${managed.name}@${managed.version} has invalid canonical metadata; run \`eidolon global init\`.`);
      }
      entry.resources = managed.files
        .map((file) => file.path)
        .filter((filePath) => filePath !== "SKILL.md");
      canonicalSystemEntries[managed.name] = entry;
    }
    requireCanonicalSystemSkills(canonicalSystemEntries, globalRoot, manifest);
    Object.assign(authorizedGlobalEntries, canonicalSystemEntries);
  }

  const workspaceEntries = loadSkillEntriesFromDir(path.join(input.workspaceRoot, ".eidolon", "skills"), {
    includeDirectory: (name) => !name.startsWith("sys-"),
  });
  const ordinaryWorkspaceEntries = Object.fromEntries(
    Object.entries(workspaceEntries).filter(([name, entry]) => (
      !name.startsWith("sys-") && !path.basename(entry.dir).startsWith("sys-")
    )),
  );
  return { ...authorizedGlobalEntries, ...ordinaryWorkspaceEntries };
}

export async function readInstalledSystemSkillResource(input: {
  globalRoot?: string;
  skillName: string;
  relativePath: string;
}): Promise<string> {
  assertSystemSkillName(input.skillName);
  assertSafeRelativeFilePath(input.relativePath, input.skillName);
  const globalRoot = resolveEidolonGlobalRoot(input.globalRoot);
  const skillsRoot = path.join(globalRoot, "skills");
  const manifest = await readManifestAtSkillsRoot(skillsRoot);
  assertExpectedManagedSystemSkillSet(manifest);
  const skill = manifest.skills.find((entry) => entry.name === input.skillName);
  if (!skill) throw new Error(`SYSTEM_SKILL_NOT_MANAGED: ${input.skillName} is not in ${SYSTEM_SKILL_MANIFEST_FILE}`);
  const file = skill.files.find((entry) => entry.path === input.relativePath);
  if (!file) throw new Error(`SYSTEM_SKILL_FILE_NOT_MANAGED: ${input.skillName}/${input.relativePath} is not in the manifest`);
  const bytes = await readManagedFile(skillsRoot, skill, file);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function loadSystemSkillContext(input: {
  globalRoot?: string;
  skillName: string;
  relativePaths: readonly string[];
}): Promise<string> {
  if (input.relativePaths.length === 0) throw new Error("SYSTEM_SKILL_CONTEXT_EMPTY: relativePaths must not be empty");
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const relativePath of input.relativePaths) {
    if (seen.has(relativePath)) throw new Error(`SYSTEM_SKILL_CONTEXT_DUPLICATE: ${relativePath}`);
    seen.add(relativePath);
    const content = await readInstalledSystemSkillResource({
      globalRoot: input.globalRoot,
      skillName: input.skillName,
      relativePath,
    });
    sections.push(`<!-- ${input.skillName}/${relativePath} -->\n${content.trim()}`);
  }
  return sections.join("\n\n");
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
  "improving",
] as const;

export type AiWorkflowStageId = typeof AI_WORKFLOW_STAGE_IDS[number];

export async function loadAiWorkflowStageContext(input: {
  globalRoot?: string;
  stage: AiWorkflowStageId;
}): Promise<string> {
  if (!AI_WORKFLOW_STAGE_IDS.includes(input.stage)) {
    throw new Error(`Unknown AI Workflow stage: ${input.stage}`);
  }
  return loadSystemSkillContext({
    globalRoot: input.globalRoot,
    skillName: "sys-eidolon-anchor-devops",
    relativePaths: [`${input.stage}/system.md`, `${input.stage}/protocol.md`],
  });
}
