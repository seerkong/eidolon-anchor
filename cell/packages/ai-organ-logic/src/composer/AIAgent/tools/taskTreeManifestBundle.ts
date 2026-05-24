import type { AnyToolDef } from "@cell/ai-core-contract/types"
import {
  ManifestRegistryComposer,
  createComponentBundleManifest,
} from "depa-processor"
import { taskTreeReadVariants } from "./TaskTreeRead"
import { taskTreeWriteVariants } from "./TaskTreeWrite"

export const taskTreeManifestBundle = createComponentBundleManifest<AnyToolDef>({
  id: "aiagent.bundle.tasktree.variants",
  manifests: [taskTreeReadVariants, taskTreeWriteVariants],
  meta: {
    domain: "tasktree",
  },
})

export function buildTaskTreeDefaultToolDefsFromManifest(): AnyToolDef[] {
  return ManifestRegistryComposer.composeToolDefs(
    [
      taskTreeReadVariants.variants[taskTreeReadVariants.defaultVariant],
      taskTreeWriteVariants.variants[taskTreeWriteVariants.defaultVariant],
    ],
    { resolveMode: "default" },
  )
}

export function buildTaskTreeVariantToolDefsFromManifest(): AnyToolDef[] {
  return ManifestRegistryComposer.composeToolDefs([taskTreeManifestBundle], {
    resolveMode: "all",
  })
}

export function buildTaskTreeRouteKeyMapFromManifest(): Record<string, string> {
  return ManifestRegistryComposer.composeRouteKeyMap([taskTreeManifestBundle], {
    resolveMode: "all",
  })
}
