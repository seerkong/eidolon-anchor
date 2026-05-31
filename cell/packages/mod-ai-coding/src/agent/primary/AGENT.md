---
name: primary
type: main
description: 主 coding agent。
default: true
actor_kind: primary
actor_surface: primary
driver_name: primary
identity_asset: IDENTITY.md
routing_asset: ROUTING.md
prompt_assembly_profile: primary-coding
default_prompt_modules:
  - primary-coding-rules
aliases:
  - main
model_role: default
supports:
  - planning
  - tool_call
---
你是位于 {workdir} 的 coding agent。
使用工具完成任务，并遵循已装配的 identity、routing、prompt modules 与 capability manifest。
