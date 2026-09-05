import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Ajv from "ajv"

import {
  CORE_KIND_READER_REGISTRATIONS,
  CORE_KIND_SPEC_REVISIONS,
  CORE_KIND_SUBJECT_OWNERS,
  KindContractRegistry,
  KindReaderRegistry,
  SpecResolutionRegistry,
  createReaderProfile,
  resolveResourceTree,
} from "halfcode-compiler.xnl/kind-definition"
import {
  digestCanonical,
  loadResourceTree,
  type JsonSchemaValidator,
  type KindSpecRevision,
  type PortableSpec,
} from "halfcode-compiler.xnl/resource-core"
import {
  HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE,
  HOLON_EXECUTION_BINDING_KIND_OWNER,
  HOLON_EXECUTION_BINDING_KIND_READER_REGISTRATION_V1,
  HOLON_EXECUTION_BINDING_KIND_SPEC_REVISION_V1,
  canonicalHolonExecutionBindingBytes,
} from "holarchy-eidolon-adapter"
import {
  HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_SPEC_REVISION_V1,
  HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
} from "@cell/ai-organ-contract"
import {
  HOLON_TASK_RUNTIME_DEFINITION_KIND_READER_REGISTRATION_V1,
  canonicalHolonTaskRuntimeDefinitionBytes,
} from "../../src/organization/HolonTaskRuntimeContract"

const roots = new Set<string>()

afterEach(async () => {
  const pending = [...roots]
  roots.clear()
  await Promise.all(pending.map((root) => rm(root, { recursive: true, force: true })))
})

const digest = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`

const binding = Object.freeze({
  apiVersion: "eidolon.ai/v1",
  kind: "HolonExecutionBinding",
  bindingRef: "resource://eidolon.bindings.reviewer",
  snapshotRef: "resource://holarchy.snapshots.review-board",
  target: Object.freeze({ kind: "member", memberRef: "member:reviewer" }),
  adapter: Object.freeze({
    kind: "ai-agent",
    agentDefinitionRef: "resource://eidolon.agents.reviewer",
    runtimeProfileRef: "resource://eidolon.runtime-profiles.default",
  }),
  policy: Object.freeze({
    version: "1",
    runtime: Object.freeze({ mode: "shared-member-runtime" }),
    taskProfileRef: "resource://eidolon.task-profiles.review",
    capabilityRefs: Object.freeze(["resource://eidolon.capabilities.review"]),
    toolRefs: Object.freeze([]),
    materialRefs: Object.freeze([]),
  }),
})

const definition = Object.freeze({
  kind: "holon-task-runtime-definition",
  schemaVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
  definitionRef: "resource://eidolon.holon-task-runtime.reviewer",
  version: "1.0.0",
  rootHolonRef: "holon:review-board",
  executionBinding: Object.freeze({
    ref: binding.bindingRef,
    digest: digest("a"),
  }),
  taskSpace: Object.freeze({
    profileRef: "resource://eidolon.task-profiles.review",
    policyRef: "resource://eidolon.task-policies.default",
    requiredRoleRefs: Object.freeze(["role:reviewer"]),
    requiredCapabilityRefs: Object.freeze(["resource://eidolon.capabilities.review"]),
  }),
  input: Object.freeze({ schemaRef: "resource://eidolon.schemas.review-input" }),
  output: Object.freeze({
    schemaRef: "resource://eidolon.schemas.review-output",
    materialPortRefs: Object.freeze([]),
  }),
  defaultForHolon: true,
})

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false })
const validators = new Map<string, ReturnType<typeof ajv.compile>>()
const schemaValidator: JsonSchemaValidator = {
  validate(revision: KindSpecRevision, value: PortableSpec): readonly string[] {
    let validate = validators.get(revision.contractFingerprint)
    if (!validate) {
      validate = ajv.compile(revision.specSchema)
      validators.set(revision.contractFingerprint, validate)
    }
    return validate(value)
      ? []
      : (validate.errors ?? []).map((error) =>
          `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
  },
}

function registrations() {
  const contracts = new KindContractRegistry()
  for (const owner of CORE_KIND_SUBJECT_OWNERS) contracts.registerOwner(owner)
  contracts
    .registerOwner(HOLON_EXECUTION_BINDING_KIND_OWNER)
    .registerOwner(HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER)
  for (const revision of CORE_KIND_SPEC_REVISIONS) contracts.registerRevision(revision)
  contracts
    .registerRevision(HOLON_EXECUTION_BINDING_KIND_SPEC_REVISION_V1)
    .registerRevision(HOLON_TASK_RUNTIME_DEFINITION_KIND_SPEC_REVISION_V1)

  const readers = new KindReaderRegistry()
  for (const reader of CORE_KIND_READER_REGISTRATIONS) readers.register(reader)
  readers
    .register(HOLON_EXECUTION_BINDING_KIND_READER_REGISTRATION_V1)
    .register(HOLON_TASK_RUNTIME_DEFINITION_KIND_READER_REGISTRATION_V1)
  const allReaders = [
    ...CORE_KIND_READER_REGISTRATIONS,
    HOLON_EXECUTION_BINDING_KIND_READER_REGISTRATION_V1,
    HOLON_TASK_RUNTIME_DEFINITION_KIND_READER_REGISTRATION_V1,
  ]
  const readerProfile = createReaderProfile(
    "eidolon.holon-runtime.halfcode-03.v1",
    allReaders.map((reader) => ({
      readerId: reader.readerId,
      subjectFqn: reader.subjectFqn,
      readerSpecVersion: reader.readerSpecVersion,
      contractFingerprint: reader.contractFingerprint,
      readerImplementationFingerprint: reader.readerImplementationFingerprint,
    })),
  )
  return {
    contracts,
    readers,
    readerProfile,
    resolutions: new SpecResolutionRegistry(contracts),
  }
}

async function fixture(input: Readonly<{
  bindingKindSource?: string
  definitionKindSource?: string
}> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eidolon-halfcode-03-kinds-"))
  roots.add(root)
  await mkdir(join(root, "KindDefinitions/HolonExecutionBinding"), { recursive: true })
  await mkdir(join(root, "KindDefinitions/HolonTaskRuntimeDefinition"), { recursive: true })
  await mkdir(join(root, "Bindings"), { recursive: true })
  await mkdir(join(root, "TaskRuntimes"), { recursive: true })
  await writeFile(join(root, "manifest.xnl"), [
    '<ResourcePackage #eidolon.holon-runtime.test envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (',
    '  <Catalogs [',
    '    <Catalog #kind_definitions { kind = "KindDefinition" shape = "directory" root = "vfs://./KindDefinitions/" entry = "manifest.xnl" }>',
    '    <Catalog #bindings { kind = "HolonExecutionBinding" shape = "single-file" root = "vfs://./Bindings/" }>',
    '    <Catalog #task_runtimes { kind = "HolonTaskRuntimeDefinition" shape = "single-file" root = "vfs://./TaskRuntimes/" }>',
    '  ]>',
    ')>',
    '',
  ].join("\n"))
  await writeFile(
    join(root, "KindDefinitions/HolonExecutionBinding/manifest.xnl"),
    input.bindingKindSource ?? HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE,
  )
  await writeFile(
    join(root, "KindDefinitions/HolonTaskRuntimeDefinition/manifest.xnl"),
    input.definitionKindSource ?? HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE,
  )
  await writeFile(join(root, "Bindings/Reviewer.xnl"), [
    '<HolonExecutionBinding #eidolon.bindings.reviewer envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {',
    `  bindingBytesBase64 = "${Buffer.from(canonicalHolonExecutionBindingBytes(binding)).toString("base64")}"`,
    '}>',
    '',
  ].join("\n"))
  await writeFile(join(root, "TaskRuntimes/Reviewer.xnl"), [
    '<HolonTaskRuntimeDefinition #eidolon.holon-task-runtime.reviewer envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {',
    `  definitionBytesBase64 = "${Buffer.from(canonicalHolonTaskRuntimeDefinitionBytes(definition)).toString("base64")}"`,
    '}>',
    '',
  ].join("\n"))
  return root
}

describe("Eidolon Holon Kind contracts on Halfcode 0.3", () => {
  test("resolves exact binding and runtime definition reader values", async () => {
    const tree = await loadResourceTree({ rootDir: await fixture() })
    const resolved = resolveResourceTree({
      tree,
      ...registrations(),
      validator: schemaValidator,
    })

    expect(resolved.registry.byKind.get("HolonExecutionBinding")?.[0]?.readerValue)
      .toEqual(binding)
    expect(resolved.registry.byKind.get("HolonTaskRuntimeDefinition")?.[0]?.readerValue)
      .toEqual(definition)
    expect(resolved.receipts.map((receipt) => receipt.writer.contractFingerprint))
      .toContain(HOLON_EXECUTION_BINDING_KIND_SPEC_REVISION_V1.contractFingerprint)
    expect(resolved.receipts.map((receipt) => receipt.writer.contractFingerprint))
      .toContain(HOLON_TASK_RUNTIME_DEFINITION_KIND_SPEC_REVISION_V1.contractFingerprint)
  })

  test("rejects a forged Kind descriptor", async () => {
    const forged = HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE.replace(
      HOLON_EXECUTION_BINDING_KIND_SPEC_REVISION_V1.contractFingerprint,
      digestCanonical({ authority: "forged-eidolon-binding-contract" }),
    )
    const tree = await loadResourceTree({
      rootDir: await fixture({ bindingKindSource: forged }),
    })
    expect(() => resolveResourceTree({
      tree,
      ...registrations(),
      validator: schemaValidator,
    })).toThrow("KIND_DEFINITION_REVISION_MISMATCH")
  })

  test("rejects the retired Halfcode 0.2 envelope", async () => {
    const legacy = HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE.replace(
      'envelopeVersion="halfcode.resource-envelope/v1" specVersion=1',
      'apiVersion="halfcode.resources/v1" version="1.0.0"',
    )
    await expect(loadResourceTree({
      rootDir: await fixture({ definitionKindSource: legacy }),
    })).rejects.toThrow("Resource validation failed")
  })
})
