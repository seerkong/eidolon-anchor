import { createHash } from "node:crypto"
import path from "node:path"
import { mkdir, open, readFile } from "node:fs/promises"

import type {
  HolonTaskRuntimeStorage,
  HolonTaskSubmissionRecord,
} from "@cell/ai-organ-contract/organization/HolonTaskRuntimeStorage"
import { FileTaskSpaceOwner } from "task-manager-file-support"
import { FileHolonTaskPumpJournalStore } from "./FileHolonTaskPumpJournalStore"

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

async function retainSubmission(supportRoot: string, value: HolonTaskSubmissionRecord): Promise<void> {
  const directory = path.join(supportRoot, "holon-task-submissions")
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, `${digest([value.taskSpaceId, value.taskId, value.commandId]).slice(7)}.json`)
  const bytes = Buffer.from(JSON.stringify(value))
  try {
    const handle = await open(target, "wx", 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (!Buffer.from(await readFile(target)).equals(bytes)) {
      throw new Error("EIDOLON_HOLON_TASK_SUBMISSION_FINGERPRINT_CONFLICT")
    }
  }
}

/** Select physical storage at the host boundary; this factory owns no routes or task rules. */
export function createLocalHolonTaskRuntimeStorage(
  input: Readonly<{ supportRoot: string }>,
): HolonTaskRuntimeStorage {
  const supportRoot = path.resolve(input.supportRoot)
  return Object.freeze({
    supportRoot,
    taskManager: Object.freeze({
      owner: new FileTaskSpaceOwner({ root: path.join(supportRoot, "task-spaces") }),
    }),
    journalStore: new FileHolonTaskPumpJournalStore({ now: Date.now }, { supportRoot }),
    retainSubmission: (value: HolonTaskSubmissionRecord) => retainSubmission(supportRoot, value),
  })
}
