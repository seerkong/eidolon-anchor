import type { QuestionnaireRequestPayload } from "@cell/ai-core-contract/runtime/Questionnaire";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { upsertPendingQuestionnaireRow } from "@cell/ai-core-logic";
import type { ToolFuncRegistryData } from "@cell/ai-core-contract/runtime/RuntimeRegistries";
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";

import {
  type FileAccessKind,
  grantWorkspaceAccess,
  LocalPermissionConfigError,
} from "./LocalPermissionConfig";
import {
  type LocalPermissionApprovalGrant,
  type LocalPermissionDecision,
  type WorkspaceAccessApprovalGrant,
  evaluateLocalToolPermission,
} from "./LocalPermissionEvaluator";

export const LOCAL_PERMISSION_QUESTIONNAIRE_PENDING_OUTPUT = "LOCAL_PERMISSION_QUESTIONNAIRE_PENDING";

type LocalPermissionApprovalContext = {
  kind: "local_permission";
  toolName: string;
  originalArgs: Record<string, unknown>;
  approvalGrant: LocalPermissionApprovalGrant;
};

type WorkspaceAccessGrantContext = {
  kind: "workspace_access_grant";
  toolName: string;
  originalArgs: Record<string, unknown>;
  approvalGrant: WorkspaceAccessApprovalGrant;
};

type LocalPermissionQuestionnaireRequest = QuestionnaireRequestPayload & {
  approvalContext?: LocalPermissionApprovalContext | WorkspaceAccessGrantContext;
};

type ExecProtocolPermissionMode = "interactive" | "default" | "full-auto" | "dangerous";

export function resolveLocalPermissionAuthorityRootFromRuntime(runtime: any): string | undefined {
  const metadata = runtime?.vm?.outerCtx?.metadata as Record<string, unknown> | undefined;
  const raw =
    (metadata?.local_permissions as any)?.authority_root ??
    (metadata?.local_permissions as any)?.authorityRoot ??
    (metadata?.localPermissions as any)?.authority_root ??
    (metadata?.localPermissions as any)?.authorityRoot;
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

export function resolveLocalPermissionGrantFromRuntime(runtime: any): LocalPermissionApprovalGrant | WorkspaceAccessApprovalGrant | undefined {
  const raw = (runtime as any)?.localPermissionGrant;
  if (!raw || typeof raw !== "object") return undefined;
  if ((raw as any).kind === "local_permission") {
    if (typeof (raw as any).toolName !== "string") return undefined;
    if (typeof (raw as any).permissionName !== "string") return undefined;
    if (typeof (raw as any).workDir !== "string") return undefined;
    if (typeof (raw as any).target !== "string") return undefined;
    return {
      kind: "local_permission",
      toolName: String((raw as any).toolName),
      permissionName: (raw as any).permissionName,
      workDir: String((raw as any).workDir),
      target: String((raw as any).target),
    };
  }
  if ((raw as any).kind === "workspace_access_grant") {
    if (typeof (raw as any).toolName !== "string") return undefined;
    if (typeof (raw as any).workDir !== "string") return undefined;
    if (typeof (raw as any).grantPath !== "string") return undefined;
    if (typeof (raw as any).requestedAccessKind !== "string") return undefined;
    return {
      kind: "workspace_access_grant",
      toolName: String((raw as any).toolName),
      workDir: String((raw as any).workDir),
      grantPath: String((raw as any).grantPath),
      requestedAccessKind: (raw as any).requestedAccessKind,
    };
  }
  return undefined;
}

function resolveExecProtocolPermissionMode(runtime: any): ExecProtocolPermissionMode {
  const metadata = runtime?.vm?.outerCtx?.metadata as Record<string, unknown> | undefined;
  const protocol = metadata?.exec_protocol as Record<string, unknown> | undefined;
  const raw = typeof protocol?.mode === "string" ? protocol.mode.trim() : "";
  if (raw === "default" || raw === "full-auto" || raw === "dangerous") {
    return raw;
  }
  return "interactive";
}

function resolveExecProtocolAdditionalWritableRoots(runtime: any): string[] {
  const metadata = runtime?.vm?.outerCtx?.metadata as Record<string, unknown> | undefined;
  const protocol = metadata?.exec_protocol as Record<string, unknown> | undefined;
  const raw = protocol?.additional_writable_roots;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function authorizeLocalToolCall(runtime: any, toolName: string, payload: Record<string, unknown>): { ok: true } | { ok: false; output: string } {
  const workDir = String(runtime?.vm?.outerCtx?.workDir ?? "").trim();
  if (!workDir) {
    return { ok: false, output: "Error: workDir not configured" };
  }
  try {
    const execProtocolMode = resolveExecProtocolPermissionMode(runtime);
    const decision = evaluateLocalToolPermission({
      workDir,
      toolName,
      payload,
      authorityRoot: resolveLocalPermissionAuthorityRootFromRuntime(runtime),
      approvalGrant: resolveLocalPermissionGrantFromRuntime(runtime),
      additionalWritableRoots: resolveExecProtocolAdditionalWritableRoots(runtime),
    });
    if (decision.action === "allow") {
      return { ok: true };
    }
    if (execProtocolMode === "dangerous" && !String(decision.message ?? "").includes("Protected local permission config path")) {
      return { ok: true };
    }
    if (decision.action === "deny") {
      return { ok: false, output: `Error: ${decision.message || "local permission denied"}` };
    }
    if (execProtocolMode === "full-auto") {
      if (decision.approvalGrant?.kind === "workspace_access_grant") {
        return { ok: false, output: "Error: workspace access grant required" };
      }
      return { ok: true };
    }
    if (execProtocolMode === "default") {
      return {
        ok: false,
        output: `Error: ${decision.fallbackMessage || decision.message || "local permission requires approval"}`,
      };
    }
    return {
      ok: false,
      output: queueLocalPermissionQuestionnaire(runtime, toolName, payload, decision),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Error: ${message}` };
  }
}

export function isLocalPermissionQuestionnairePendingOutput(output: string): boolean {
  return output === LOCAL_PERMISSION_QUESTIONNAIRE_PENDING_OUTPUT;
}

export function getLocalPermissionApprovalContext(request: QuestionnaireRequestPayload | undefined): LocalPermissionApprovalContext | null {
  const context = (request as LocalPermissionQuestionnaireRequest | undefined)?.approvalContext;
  return context?.kind === "local_permission" ? context : null;
}

export function getWorkspaceAccessGrantContext(request: QuestionnaireRequestPayload | undefined): WorkspaceAccessGrantContext | null {
  const context = (request as LocalPermissionQuestionnaireRequest | undefined)?.approvalContext;
  return context?.kind === "workspace_access_grant" ? context : null;
}

export function isLocalPermissionApprovalAccepted(
  request: QuestionnaireRequestPayload | undefined,
  answers: Record<string, unknown> | undefined,
): boolean {
  const context = getLocalPermissionApprovalContext(request);
  if (!context) return false;
  const approved =
    answers?.approved ??
    answers?.q1 ??
    answers?.allow ??
    answers?.confirm;
  return approved === true;
}

export async function replayLocalPermissionApprovedTool(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  toolRegistry: ToolFuncRegistryData;
  request: QuestionnaireRequestPayload;
  toolCallId: string;
  approved: boolean;
}): Promise<unknown> {
  const context = getLocalPermissionApprovalContext(params.request);
  if (!context) {
    return JSON.stringify({
      questionnaireId: params.request.questionnaireId,
      status: "ok",
      answers: {},
      errors: [],
    });
  }
  if (!params.approved) {
    return `Error: local permission approval declined for ${context.approvalGrant.permissionName}: ${context.approvalGrant.target}`;
  }
  return await ToolFuncRegistry.call(params.toolRegistry, context.toolName, params.vm, params.actor, context.originalArgs, {
    toolCallId: params.toolCallId,
    localPermissionGrant: context.approvalGrant,
  } as any);
}

export async function replayWorkspaceAccessGrantApprovedTool(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  toolRegistry: ToolFuncRegistryData;
  request: QuestionnaireRequestPayload;
  toolCallId: string;
  answers: Record<string, unknown>;
}): Promise<unknown> {
  const context = getWorkspaceAccessGrantContext(params.request);
  if (!context) {
    return JSON.stringify({
      questionnaireId: params.request.questionnaireId,
      status: "ok",
      answers: {},
      errors: [],
    });
  }
  const selected = String(
    params.answers?.access_grant ??
      params.answers?.approved ??
      params.answers?.q1 ??
      "",
  ).trim();
  if (!selected || selected === "deny_permission_grant" || selected === "reject" || selected === "denied") {
    return `Error: workspace access grant declined for ${context.approvalGrant.grantPath}`;
  }
  const accessKind: FileAccessKind = selected === "grant_read" ? "read" : "write";
  grantWorkspaceAccess({
    workDir: context.approvalGrant.workDir,
    targetPath: context.approvalGrant.grantPath,
    accessKind,
    authorityRoot: resolveLocalPermissionAuthorityRootFromRuntime({ vm: params.vm }),
  });
  const grant: WorkspaceAccessApprovalGrant = {
    ...context.approvalGrant,
    requestedAccessKind: accessKind,
  };
  return await ToolFuncRegistry.call(params.toolRegistry, context.toolName, params.vm, params.actor, context.originalArgs, {
    toolCallId: params.toolCallId,
    localPermissionGrant: grant,
  } as any);
}

function queueLocalPermissionQuestionnaire(
  runtime: any,
  toolName: string,
  payload: Record<string, unknown>,
  decision: LocalPermissionDecision,
): string {
  if (!decision.approvalGrant) {
    return `Error: ${decision.message || "local permission requires approval"}`;
  }
  if (!runtime?.actor || typeof runtime.actor !== "object") {
    return `Error: ${decision.fallbackMessage || decision.message || "local permission requires approval"}`;
  }
  const toolCallId = String(runtime?.toolCallId ?? "").trim() || `tc-local-permission-${Date.now()}`;
  const questionnaireId = `local-permission-${toolCallId}`;
  const request: LocalPermissionQuestionnaireRequest = {
    questionnaireId,
    toolCallId,
    kind: "approval",
    title: "Local Permission Approval",
    intro: decision.message || "Approve this local permission request?",
    suspendPolicy: "pause_all",
    questions:
      decision.approvalGrant.kind === "workspace_access_grant"
        ? buildWorkspaceGrantQuestions(decision.approvalGrant)
        : [
            {
              id: "approved",
              prompt: decision.message || "Approve this local permission request?",
              type: "yes_no",
              required: true,
            },
          ],
    approvalContext:
      decision.approvalGrant.kind === "workspace_access_grant"
        ? {
            kind: "workspace_access_grant",
            toolName,
            originalArgs: cloneJsonRecord(payload),
            approvalGrant: decision.approvalGrant,
          }
        : {
            kind: "local_permission",
            toolName,
            originalArgs: cloneJsonRecord(payload),
            approvalGrant: decision.approvalGrant,
          },
  };

  runtime.actor.pendingQuestionnaires = runtime.actor.pendingQuestionnaires ?? {};
  const existing = runtime.actor.pendingQuestionnaires[questionnaireId];
  if (!existing) {
    runtime.actor.pendingQuestionnaires[questionnaireId] = request;
    upsertPendingQuestionnaireRow({ vm: runtime.vm as any, actor: runtime.actor as any, request });
    runtime.actor.send("control", {
      kind: "questionnaire_pending",
      toolCallId,
      questionnaireId,
      suspendPolicy: request.suspendPolicy,
    });

    const bus = runtime?.vm?.eventBus;
    if (bus && typeof bus.emitQuestionnaireRequest === "function") {
      bus.emitQuestionnaireRequest({ key: runtime.actor.key, id: runtime.actor.id }, request);
    }
  }

  return LOCAL_PERMISSION_QUESTIONNAIRE_PENDING_OUTPUT;
}

function buildWorkspaceGrantQuestions(approvalGrant: WorkspaceAccessApprovalGrant): QuestionnaireRequestPayload["questions"] {
  const choices =
    approvalGrant.requestedAccessKind === "read"
      ? [
          { value: "grant_read", label: "授权只读" },
          { value: "grant_read_write", label: "授权读写" },
          { value: "deny_permission_grant", label: "拒绝授权" },
        ]
      : [
          { value: "grant_read_write", label: "授权读写" },
          { value: "deny_permission_grant", label: "拒绝授权" },
        ];
  return [
    {
      id: "access_grant",
      prompt:
        approvalGrant.requestedAccessKind === "write"
          ? `为当前 workspace 授权目录 ${approvalGrant.grantPath} 的读写访问`
          : `为当前 workspace 授权目录 ${approvalGrant.grantPath} 的访问`,
      type: "single_select",
      required: true,
      choices,
    },
  ];
}

function cloneJsonRecord(payload: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(payload);
  } catch {
    try {
      return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    } catch {
      return { ...payload };
    }
  }
}
