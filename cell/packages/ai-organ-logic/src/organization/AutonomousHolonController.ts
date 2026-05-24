import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import type { MemberManager } from "@cell/ai-organ-logic/organization/MemberManager"
import type { AiAgentOrchestratorDriver } from "../OrchestratorDriver"
import { createAutonomousHolonTaskRunner, type AutonomousHolonTaskRunner } from "./AutonomousHolonTaskRunner"

export type AutonomousHolonController = {
  enabled: boolean
  idleTimeoutMs: number
  tickIntervalMs: number
  lastTickAt: number
  start: (params?: { idleTimeoutMs?: number; tickIntervalMs?: number }) => void
  tick: () => Promise<void>
  shouldAutoTick: (now: number) => boolean
  status: () => AutonomousHolonControllerStatus
  restoreStatus: (status: Partial<AutonomousHolonControllerStatus>) => AutonomousHolonControllerStatus
}

export type AutonomousHolonControllerStatus = {
  enabled: boolean
  idleTimeoutMs: number
  tickIntervalMs: number
  lastTickAt: number
}

export function createAutonomousHolonController(params: {
  driver: AiAgentOrchestratorDriver
  vm: AiAgentVm
  controlActor: AiAgentActor
  members: MemberManager
  idleTimeoutMs?: number
  tickIntervalMs?: number
}): AutonomousHolonController {
  let enabled = false
  let idleTimeoutMs = typeof params.idleTimeoutMs === "number" && params.idleTimeoutMs > 0 ? params.idleTimeoutMs : 30_000
  let tickIntervalMs = typeof params.tickIntervalMs === "number" && params.tickIntervalMs > 0 ? params.tickIntervalMs : 5_000
  let lastTickAt = 0

  const getStatus = (): AutonomousHolonControllerStatus => ({
    enabled,
    idleTimeoutMs,
    tickIntervalMs,
    lastTickAt,
  })

  const makeRunner = (): AutonomousHolonTaskRunner =>
    createAutonomousHolonTaskRunner({
      driver: params.driver,
      vm: params.vm,
      controlActor: params.controlActor,
      members: params.members,
      idleTimeoutMs,
    })

  let runner = makeRunner()

  return {
    get enabled() {
      return enabled
    },
    get idleTimeoutMs() {
      return idleTimeoutMs
    },
    get tickIntervalMs() {
      return tickIntervalMs
    },
    get lastTickAt() {
      return lastTickAt
    },
    start(config) {
      enabled = true
      if (typeof config?.idleTimeoutMs === "number" && config.idleTimeoutMs > 0) {
        idleTimeoutMs = config.idleTimeoutMs
      }
      if (typeof config?.tickIntervalMs === "number" && config.tickIntervalMs > 0) {
        tickIntervalMs = config.tickIntervalMs
      }
      runner = makeRunner()
    },
    async tick() {
      lastTickAt = Date.now()
      await runner.tickOnce()
    },
    shouldAutoTick(now) {
      return enabled && (lastTickAt === 0 || now - lastTickAt >= tickIntervalMs)
    },
    status() {
      return getStatus()
    },
    restoreStatus(status) {
      if (typeof status.enabled === "boolean") {
        enabled = status.enabled
      }
      if (typeof status.idleTimeoutMs === "number" && status.idleTimeoutMs > 0) {
        idleTimeoutMs = status.idleTimeoutMs
      }
      if (typeof status.tickIntervalMs === "number" && status.tickIntervalMs > 0) {
        tickIntervalMs = status.tickIntervalMs
      }
      if (typeof status.lastTickAt === "number" && Number.isFinite(status.lastTickAt) && status.lastTickAt >= 0) {
        lastTickAt = status.lastTickAt
      }
      runner = makeRunner()
      return getStatus()
    },
  }
}
