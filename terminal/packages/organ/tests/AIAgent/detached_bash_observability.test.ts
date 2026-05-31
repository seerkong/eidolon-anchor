import { describe, expect, it } from "bun:test"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { configureLocalPermissionConfigStore } from "@cell/ai-organ-logic"
import { LocalFilePermissionConfigStore } from "@cell/ai-support"
import fs from "fs"
import os from "os"
import path from "path"

configureLocalPermissionConfigStore(LocalFilePermissionConfigStore)

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("timed out waiting for predicate")
}

describe("RunDetachedBash observability", () => {
  it("exposes stdout and stderr while running and returns a terminal result", async () => {
    const workDir = makeTempDir("detached-bash-observability-")
    const actor = createActor({ key: "main" })
    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      outerCtx: { workDir },
      registries: { toolRegistry },
    })

    const command = [
      "printf out-one",
      "printf err-one >&2",
      "sleep 0.3",
      "printf out-two",
      "printf err-two >&2",
    ].join("; ")

    const started = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "RunDetachedBash", vm, actor, {
      command,
      agent_type: "code",
      timeoutSeconds: 5,
    })))

    expect(typeof started.task_id).toBe("string")

    await waitFor(async () => {
      const stdoutLogs = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorLogs", vm, actor, {
        task_id: started.task_id,
        sources: ["stdout"],
      })))
      return stdoutLogs.entries.some((entry: any) => String(entry.text).includes("out-one"))
    })

    await waitFor(async () => {
      const logs = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorLogs", vm, actor, {
        task_id: started.task_id,
        sources: ["stderr"],
      })))
      return logs.entries.some((entry: any) => String(entry.text).includes("err-one"))
    })

    const stderrLogs = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorLogs", vm, actor, {
      task_id: started.task_id,
      sources: ["stderr"],
    })))
    expect(stderrLogs.entries.map((entry: any) => entry.text).join("")).toContain("err-one")

    await waitFor(async () => {
      const result = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorResult", vm, actor, {
        task_id: started.task_id,
        allow_partial: true,
        include_logs: true,
      })))
      return result.status === "completed"
    })

    const result = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorResult", vm, actor, {
      task_id: started.task_id,
      include_logs: true,
      sources: ["stdout"],
    })))
    expect(result.status).toBe("completed")
    expect(result.output_text).toContain("out-one")
    expect(result.output_text).toContain("err-one")
    expect(result.logs.entries.map((entry: any) => entry.text).join("")).toContain("out-two")
  })
})
