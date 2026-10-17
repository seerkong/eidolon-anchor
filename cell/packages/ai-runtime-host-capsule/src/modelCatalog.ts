import { existsSync } from "node:fs"
import { join } from "node:path"
import { loadProviderCatalog, defaultProviderConfigPath, PROVIDER_CONFIG_FILE_NAME } from "@cell/ai-organ-logic"
import type { HostCapabilities } from "@cell/ai-runtime-host-contract"

/** Same project-before-home resolution as the runtime model resolver. Only explicit public fields leave Anchor. */
export function readHostModelCatalog(workDir: string, globalRoot?: string): NonNullable<HostCapabilities["modelCatalog"]> {
  try {
    const local = join(workDir, ".eidolon", PROVIDER_CONFIG_FILE_NAME)
    const catalog = loadProviderCatalog(existsSync(local) ? local : globalRoot ? join(globalRoot, PROVIDER_CONFIG_FILE_NAME) : defaultProviderConfigPath())
    const models = catalog.providers.flatMap(provider => provider.models.map(model => ({ providerId: provider.name, modelId: model.name })))
    if (models.length > 4096 || Buffer.byteLength(JSON.stringify(models)) > 512 * 1024 || models.some(model => new TextEncoder().encode(model.providerId).length > 256 || new TextEncoder().encode(model.modelId).length > 256)) return { models: [], error: "model_catalog_capacity" }
    return models.length ? { models } : { models: [], error: "model_catalog_empty" }
  } catch { return { models: [], error: "model_catalog_unavailable" } }
}
