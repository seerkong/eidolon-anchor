import { afterEach, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { depaAIResourceKindContract } from "ai-workflow-contract";
import { createActorDurableMaterial } from "@cell/ai-core-logic/runtime/ActorDurableMaterial";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = path.join(import.meta.dir, "fixtures/frozenFactPresentationProcess.ts");
const sessionBinding = path.resolve(".tmp/holon-resource-autonomy-source.json");
function resolveSourceBinding(): string {
  if (process.env.EIDOLON_TEST_TSCONFIG) return path.resolve(process.env.EIDOLON_TEST_TSCONFIG);
  if (existsSync(sessionBinding)) return sessionBinding;
  return path.resolve(import.meta.dir, "../../../../tsconfig.json");
}
const sourceBinding = resolveSourceBinding();

async function child(phase: "capture" | "restore", root: string, snapshot: string) {
  const handle = Bun.spawn([process.execPath, "--tsconfig-override", sourceBinding, fixture, phase, root, snapshot],
    { stdout: "pipe", stderr: "pipe", cwd: root });
  const timer = setTimeout(() => handle.kill("SIGKILL"), 20_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([handle.exited, new Response(handle.stdout).text(), new Response(handle.stderr).text()]);
    return { exit, stdout, stderr };
  } finally { clearTimeout(timer); }
}

function contextResource(layout: "canonical" | "pretty") {
  return `<AgentContextPipeline #fixture.Context envelopeVersion="halfcode.resource-envelope/v1" specVersion=2 { lifecycle="Active" } (
    <CodeBinding { packageName="fixture-code" module="./context.ts" exportName="buildContext" }>
    <Config { value={ factPresentationProtocol="eidolon.context-fact-presentation/v1" jsonLayout="${layout}" } }>
  )>`;
}

async function workspaceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-frozen-fact-")); roots.push(root);
  const resourceRoot = path.join(root, ".eidolon/resources");
  const files: Record<string, string> = {
    "manifest.xnl": `<ResourcePackage #fixture.package envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle="Active" packageVersion="1.0.0" } (
      <Catalogs [
        <Catalog #kinds { kind="KindDefinition" shape="directory" root="vfs://./KindDefinitions/" entry="manifest.xnl" }>
        <Catalog #agents { kind="AIAgentDefinition" shape="single-file" root="vfs://./Agents/" }>
        <Catalog #prompts { kind="Prompt" shape="single-file" root="vfs://./Prompts/" }>
        <Catalog #context { kind="AgentContextPipeline" shape="single-file" root="vfs://./ContextPipelines/" }>
      ]>
    )>`,
    "KindDefinitions/AIAgentDefinition/manifest.xnl": depaAIResourceKindContract("AIAgentDefinition").kindDefinitionSource,
    "KindDefinitions/Prompt/manifest.xnl": depaAIResourceKindContract("Prompt").kindDefinitionSource,
    "KindDefinitions/AgentContextPipeline/manifest.xnl": depaAIResourceKindContract("AgentContextPipeline", 2).kindDefinitionSource,
    "Agents/Agent.xnl": `<AIAgentDefinition #fixture.Agent envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle="Active" } (
      <MessagePrefix [<Message #system { role="system" promptKind="Prompt" promptRef="resource://fixture.Prompt" }>]>
      <ContextPipeline { kind="AgentContextPipeline" ref="resource://fixture.Context" }>
      <ToolRefs []><MaterialPortRefs []>
    )>`,
    "Prompts/Prompt.xnl": `<Prompt #fixture.Prompt envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle="Active" template="stable prefix" }>`,
    "ContextPipelines/Context.xnl": contextResource("canonical"),
    "context.ts": `import { payloadKeys } from "./helper.ts";
      export function buildContext(runtime, input, config) {
        if (input.kind === "describe-fact-presentation") return { schemaVersion: config.factPresentationProtocol,
          rules: [{ namespace: "workflow-stage-context", payloadKeys, jsonLayout: config.jsonLayout }] };
        const messages = runtime.materialize(runtime.plan());
        return runtime.convert(input.mode === "estimate" ? runtime.completeEstimate(messages) : messages);
      }`,
    "helper.ts": `export const payloadKeys = ["stage", "context", "allowedTools"];`,
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(resourceRoot, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
  }
  return { root, resourceRoot, snapshot: path.join(root, "v1.snapshot.json") };
}

function fact(messages: any[]) {
  const message = messages.find(message => String(message.content).startsWith("eidolon-context-fact/v1\n"));
  expect(message).toBeDefined();
  return { message, value: JSON.parse(message.content.slice("eidolon-context-fact/v1\n".length)) };
}

it("freezes native V1 presentation across source/config V2 and a fresh process with no live files", async () => {
  const f = await workspaceFixture();
  const first = await child("capture", f.root, f.snapshot); expect(first.exit, first.stderr).toBe(0);
  const v1 = JSON.parse(first.stdout);
  const saved = JSON.parse(await readFile(f.snapshot, "utf8"));
  const material = saved.actor.durableMaterials[saved.actor.contextPipeline.materialDigest];
  expect(JSON.parse(Buffer.from(material.bytes, "base64").toString("utf8")).factPresentation).toEqual(v1.recipe);
  expect(saved.actor.contextPipelineExecution).toBeUndefined();
  await writeFile(path.join(f.resourceRoot, "helper.ts"), `export const payloadKeys = ["stage", "context", "allowedTools", "packageProvenanceDigest"];`);
  await writeFile(path.join(f.resourceRoot, "ContextPipelines/Context.xnl"), contextResource("pretty"));
  const second = await child("capture", f.root, path.join(f.root, "v2.snapshot.json")); expect(second.exit, second.stderr).toBe(0);
  const v2 = JSON.parse(second.stdout);
  expect(v2.binding.resourceId).toBe(v1.binding.resourceId);
  expect(v2.binding.executionDigest).not.toBe(v1.binding.executionDigest);
  expect(v2.binding.materialDigest).not.toBe(v1.binding.materialDigest);
  expect(fact(v1.record).value.payload).toEqual({ stage: "coding", context: "already admitted instructions", allowedTools: ["read"] });
  expect(fact(v2.record).value.payload).toEqual({ ...fact(v1.record).value.payload, packageProvenanceDigest: "original provenance" });
  expect(fact(v2.record).message.content).toContain('\n  "namespace"');
  expect(v2.record.filter((message: any) => message.role === "system")).toEqual(v1.record.filter((message: any) => message.role === "system"));
  expect(v1.record[1]).toEqual({ role: "user", content: "original history anchor" });
  await rm(f.resourceRoot, { recursive: true });
  const recovered = await child("restore", f.root, f.snapshot); expect(recovered.exit, recovered.stderr).toBe(0);
  const restored = JSON.parse(recovered.stdout);
  expect(restored.pid).not.toBe(v1.pid); expect(restored.pid).not.toBe(v2.pid); expect(restored.pid).not.toBe(process.pid);
  const { pid: originalPid, ...original } = v1;
  const { pid: restoredPid, ...actual } = restored;
  expect(actual).toEqual(original);
  expect(restored.record).toEqual(restored.estimate);
  expect(restored.generations).toBe(1);
}, 30_000);

it.each(["missing", "changed"])("rejects %s stored recipe even when outer material and trusted binding are consistently readdressed", async mode => {
  const f = await workspaceFixture();
  const captured = await child("capture", f.root, f.snapshot); expect(captured.exit, captured.stderr).toBe(0);
  const saved = JSON.parse(await readFile(f.snapshot, "utf8"));
  const original = saved.actor.durableMaterials[saved.actor.contextPipeline.materialDigest];
  const bundle = JSON.parse(Buffer.from(original.bytes, "base64").toString("utf8"));
  if (mode === "missing") delete bundle.factPresentation;
  else bundle.factPresentation.rules[0].payloadKeys = ["stage"];
  // Deliberately readdress BOTH the outer bytes and the fixture's trusted binding;
  // recovery must still compare the persisted recipe with original frozen code/config.
  const material = createActorDurableMaterial(JSON.stringify(bundle), original.mediaType);
  saved.actor.durableMaterials = { [material.digest]: material };
  saved.actor.contextPipeline.materialDigest = material.digest;
  await writeFile(f.snapshot, JSON.stringify(saved));
  await rm(f.resourceRoot, { recursive: true });
  const recovered = await child("restore", f.root, f.snapshot);
  expect(recovered.exit).toBe(1); expect(recovered.stdout).toBe("");
  expect(recovered.stderr).toContain("EIDOLON_CONTEXT_FACT_PRESENTATION_FROZEN_MISMATCH");
}, 30_000);
