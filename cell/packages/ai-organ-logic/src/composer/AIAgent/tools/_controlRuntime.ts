import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import { ensureVmRuntimeContext, type AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import type { AiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver"
import type { MemberManager } from "@cell/ai-organ-logic/organization/MemberManager"
import { getMemberManager } from "@cell/ai-organ-logic/organization/MemberManager"

export function requireControlActor(actor: AiAgentActor): string | null {
  return actor.type === "primary"
    ? null
    : "Error: tool is only available to primary actors"
}

export function getDriver(vm: AiAgentVm): AiAgentOrchestratorDriver | null {
  return (ensureVmRuntimeContext(vm).driver as AiAgentOrchestratorDriver | null) ?? null
}

export function getControlRuntimeContext(vm: AiAgentVm, actor: AiAgentActor) {
  const err = requireControlActor(actor)
  if (err) throw new Error(err)
  const driver = getDriver(vm)
  if (!driver) throw new Error("missing_driver")
  const memberManager: MemberManager = getMemberManager()
  const members = {
    createMember: (params: Omit<Parameters<MemberManager["createMember"]>[0], "vm">) => memberManager.createMember({ ...params, vm }),
    listMembers: () => memberManager.listMembers({ vm }),
    listRosterRecords: () => memberManager.listRosterRecords({ vm }),
    listMemberRecords: () => memberManager.listMemberRecords({ vm }),
    resolveMember: (query: string) => memberManager.resolveMember({ vm, query }),
    getMemberView: (query: string) => memberManager.getMemberView({ vm, query }),
    getMember: (memberId: string) => memberManager.getMember({ vm, memberId }),
    findByActor: (params: { actorKey: string; actorId?: string }) => memberManager.findByActor({ vm, ...params }),
    markMemberActive: (memberId: string) => memberManager.markMemberActive({ vm, memberId }),
    markMemberShutdownRequested: (memberId: string, requestId?: string) => memberManager.markMemberShutdownRequested({ vm, memberId, requestId }),
    markMemberExited: (memberId: string) => memberManager.markMemberExited({ vm, memberId }),
    markExitedByActor: (params: { actorKey: string; actorId?: string }) => memberManager.markExitedByActor({ vm, ...params }),
    sendMessage: (params: { to: string; from: string; text: string }) => memberManager.sendMessage({ vm, ...params }),
    broadcast: (params: { from: string; text: string }) => memberManager.broadcast({ vm, ...params }),
  }
  return { driver, members, vm }
}
