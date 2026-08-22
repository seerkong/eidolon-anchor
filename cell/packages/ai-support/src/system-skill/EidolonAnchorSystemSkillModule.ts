import { fileURLToPath } from "node:url"

import type { AuthoringModuleDescriptor } from "halfcode-compiler.xnl"

export const EIDOLON_ANCHOR_SYSTEM_SKILL_MODULE: AuthoringModuleDescriptor = Object.freeze({
  id: "EidolonAnchorSystemSkills",
  packageName: "@cell/ai-support",
  family: "eidolon-anchor-system-skills",
  scope: "domain",
  resourceRootDir: fileURLToPath(new URL("./resource-package/", import.meta.url)),
})
