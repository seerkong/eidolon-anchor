import { createHash, randomUUID } from "node:crypto"

import {
  ActorRuntime,
  createCompletionSignalRegistry,
} from "depa-actor"
import type { TaskProcessorConfig } from "task-manager-logic"

import {
  pumpHolonTaskSpace,
  type HolonTaskSpacePumpResult,
  type PumpHolonTaskSpaceInput,
} from "./HolonTaskSpacePump"
import type { HolonWorkflowTaskProcessorRuntime } from "./HolonWorkflowTaskRuntime"

export interface HolonTaskSpaceCoordinatorActorIdentity {
  readonly deploymentId: string
  readonly holonRef: string
}

type HolonTaskSpaceCoordinatorMailbox = Readonly<{
  pump: Readonly<{
    requestId: string
    input: PumpHolonTaskSpaceInput
  }>
}>

type PumpOutcome = Readonly<
  | { readonly ok: true; readonly result: HolonTaskSpacePumpResult }
  | { readonly ok: false; readonly error: Error }
>

type PumpCapability = Readonly<{
  runtime: HolonWorkflowTaskProcessorRuntime
}>

/**
 * One virtual coordinator activation backed by the project's depa-actor
 * mailbox primitive. Durable facts stay in TaskSpace, deployment state, and
 * the journal; an activation can therefore be reconstructed for the same
 * logical `(deploymentId, holonRef)` address after a process restart.
 */
export class HolonTaskSpaceCoordinatorActor {
  readonly actorId: string
  private readonly capabilities = new Map<string, PumpCapability>()
  private readonly completions = createCompletionSignalRegistry<string, PumpOutcome>()
  private readonly mailbox: ActorRuntime<undefined, HolonTaskSpaceCoordinatorMailbox>
  private readonly scheduledWakes = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    readonly identity: HolonTaskSpaceCoordinatorActorIdentity,
    private readonly config: TaskProcessorConfig,
  ) {
    this.actorId = `holon-task-space-coordinator-${createHash("sha256")
      .update(JSON.stringify([identity.deploymentId, identity.holonRef]))
      .digest("hex")
      .slice(0, 40)}`
    this.mailbox = new ActorRuntime(() => undefined)
    this.mailbox.register(this.actorId, {
      initialState: undefined,
      handlers: {
        pump: async (_self, envelope) => {
          const capability = this.capabilities.get(envelope.payload.requestId)
          if (!capability) {
            this.completions.resolve(envelope.payload.requestId, Object.freeze({
              ok: false,
              error: new Error("EIDOLON_HOLON_COORDINATOR_CAPABILITY_MISSING"),
            }))
            return
          }
          try {
            const result = await pumpHolonTaskSpace(capability.runtime, envelope.payload.input, this.config)
            this.completions.resolve(envelope.payload.requestId, Object.freeze({ ok: true, result }))
          } catch (error) {
            this.completions.resolve(envelope.payload.requestId, Object.freeze({
              ok: false,
              error: error instanceof Error ? error : new Error(String(error)),
            }))
          } finally {
            this.capabilities.delete(envelope.payload.requestId)
          }
        },
      },
    })
  }

  wake(
    runtime: HolonWorkflowTaskProcessorRuntime,
    input: PumpHolonTaskSpaceInput,
  ): Promise<HolonTaskSpacePumpResult> {
    this.assertSubscription(input)
    this.cancelScheduledWake(input.subscription.subscriptionId)
    const requestId = randomUUID()
    this.capabilities.set(requestId, Object.freeze({ runtime }))
    return new Promise<PumpOutcome>((resolve) => {
      const unsubscribe = this.completions.subscribe(requestId, (outcome) => {
        unsubscribe()
        resolve(outcome)
      })
      this.mailbox.sendFrom("workflow-holon-pump-host", this.actorId, "pump", Object.freeze({
        requestId,
        input,
      }))
    }).then((outcome) => {
      if (!outcome.ok) throw outcome.error
      return outcome.result
    })
  }

  /**
   * Register a reconstructible change probe for a durable subscription. The
   * timer owns no task or scheduling truth: it only asks the host to enqueue a
   * new typed mailbox wake, and can be lost/recreated from the journal safely.
   */
  scheduleWake(
    input: Pick<PumpHolonTaskSpaceInput, "subscription">,
    enqueueHostWake: () => void | Promise<void>,
    delayMs: number,
  ): void {
    this.assertSubscription(input)
    if (!Number.isSafeInteger(delayMs) || delayMs <= 0) {
      throw new Error("EIDOLON_HOLON_COORDINATOR_WAKE_DELAY_INVALID")
    }
    const subscriptionId = input.subscription.subscriptionId
    if (this.scheduledWakes.has(subscriptionId)) return
    const schedule = () => {
      const timer = setTimeout(() => {
        this.scheduledWakes.delete(subscriptionId)
        Promise.resolve(enqueueHostWake()).catch(() => schedule())
      }, delayMs)
      timer.unref?.()
      this.scheduledWakes.set(subscriptionId, timer)
    }
    schedule()
  }

  private cancelScheduledWake(subscriptionId: string): void {
    const timer = this.scheduledWakes.get(subscriptionId)
    if (!timer) return
    clearTimeout(timer)
    this.scheduledWakes.delete(subscriptionId)
  }

  private assertSubscription(input: Pick<PumpHolonTaskSpaceInput, "subscription">): void {
    if (input.subscription.deploymentId !== this.identity.deploymentId
      || input.subscription.holonRef !== this.identity.holonRef) {
      throw new Error("EIDOLON_HOLON_COORDINATOR_SUBSCRIPTION_MISMATCH")
    }
  }
}
