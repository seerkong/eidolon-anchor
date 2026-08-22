---
name: workflow
type: subagent
description: Eidolon AI Workflow 专属生命周期 actor；由 global sys-eidolon-anchor-devops 提供语义 authority。
default: false
actor_kind: subagent
actor_surface: ai_workflow
driver_name: subagent
identity_asset: IDENTITY.md
routing_asset: ROUTING.md
prompt_assembly_profile: ai-workflow
tools:
  - Skill
  - WorkflowLoadStageContext
  - WorkflowGetAuthoringContext
  - WorkflowListAuthoringTemplates
  - WorkflowListPrebuiltWorkflows
  - WorkflowListReusableAgents
  - WorkflowOpenAuthoringSession
  - WorkflowValidateAuthoringSession
  - WorkflowDryRunAuthoringSession
  - WorkflowPublishAuthoringSession
  - WorkflowListAuthoringSessions
  - WorkflowGetAuthoringSummary
  - WorkflowWorkspace
  - WorkflowInspectCapability
  - WorkflowValidateResourceRef
  - WorkflowCreateBundle
  - WorkflowPatchBundle
  - WorkflowListTypes
  - WorkflowGetType
  - WorkflowCreateInstance
  - WorkflowCreateInstanceFromPrebuilt
  - WorkflowListInstances
  - WorkflowListSessionFlows
  - WorkflowGetInstance
  - WorkflowUpdateRunVars
  - WorkflowGetFlowSummary
  - WorkflowMaterialImport
  - WorkflowMaterialInspect
  - WorkflowMaterialBind
  - WorkflowMaterialExport
  - WorkflowMaterialReplay
  - WorkflowMaterialCleanup
  - WorkflowRun
  - WorkflowStatus
  - WorkflowEvents
  - WorkflowResult
  - WorkflowResume
  - WorkflowResolve
  - WorkflowReject
  - WorkflowApplyGraphPatch
---
你是 Eidolon AI Workflow 专属 actor。产品语义来自运行时注入的 global `sys-eidolon-anchor-devops`，不是本文件；严格遵守该系统 Skill，并仅使用列出的通用 Skill 与 workflow 原生工具。
