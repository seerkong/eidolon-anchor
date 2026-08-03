# Mission Design

## 控制目标

Desired state：

- Eidolon 中存在一个 AI Workflow native component，负责 workflow command/query 与受控写入。
- 对话内 AI tools 和 `eidolon workflow` CLI 都只是该 component 的不同 surface。
- Workflow execution 尽量复用 Eidolon actor/session/runtime-control；workflow 层只记录 workflow facts。
- Resource authoring 使用 XNL bundle 和标准 resource ref；`.eidolon` 只作为运行时注入根，不成为业务资源身份。

Actual state：

- AI workflow contract 与基础 native tools 已存在。
- 对话内已有 workflow inspect / resource ref validation 能力。
- CLI 已可通过普通 agent prompt 生成 workflow 文件，但这只是泛用写入能力，不是 workflow component 受控写入。
- CLI runtime metadata 尚未统一把 workflow roots 注入到 workflow capability 中。

Actuation：

- 创建并执行一组真实 Codument tracks。
- 在 track 中实现 component/service、tool adapter、CLI adapter、runtime run adapter 与 tests。
- 每个 track 完成后根据 tests、CLI smoke、tool registry evidence 更新 mission actual state。

Feedback / drift：

- 如果发现 Eidolon 标准化组件协议有更准确的位置，允许受控重规划目录布局。
- 如果现有 actor/session/runtime-control API 不足以承载 workflow run，先记录 gap 并切出 runtime-control 补强 track，而不是在 workflow 层创建特例 store。
- 如果 resource bundle 标准与 depa-flows 文档发生变化，先同步 contract，再调整 tools/CLI。

## 组件分层

```text
depa-flows AI workflow core
  -> Eidolon AI Workflow native component
       -> Eidolon conversation tools
       -> eidolon workflow CLI
```

本次 Eidolon 集成不做 MCP。MCP adapter 只属于 depa-flows 独立使用场景。

## 目标目录布局

公共 contract：

```text
cell/packages/ai-workflow-contract/
```

Eidolon workflow 集成主体：

```text
cell/packages/ai-organ-logic/src/workflow/
  component/
    WorkflowComponent.ts
    WorkflowCommandService.ts
    WorkflowQueryService.ts
  effects/
    index.ts
    AgentTaskEffectProvider.ts
    ToolCallEffectProvider.ts
    HumanInputEffectProvider.ts
    MaterialEffectProvider.ts
  tools/
    index.ts
    WorkflowInspectCapability.ts
    WorkflowValidateResourceRef.ts
    WorkflowCreateBundle.ts
    WorkflowPatchBundle.ts
    WorkflowRun.ts
  prompts/
    universal.md
    ai-workflow.md
    scaffold.md
    repair.md
    infer.md
```

CLI wrapper：

```text
terminal/packages/cli/src/commands/workflow.ts
terminal/packages/organ-support/src/workflow/
```

CLI command registration：

```text
terminal/packages/cli/src/headless-main.ts
terminal/packages/cli/src/index.ts
```

## 对话 tools

对话中应能复用 workflow 能力，至少包括：

- `WorkflowInspectCapability`
- `WorkflowValidateResourceRef`
- `WorkflowCreateBundle`
- `WorkflowPatchBundle`
- `WorkflowRun`
- `WorkflowStatus`
- `WorkflowEvents`
- `WorkflowResult`
- `WorkflowResume`

这些 tools 不应直接复制 CLI 逻辑，而应调用 workflow component/service。

## CLI 命令族

第一批 authoring 命令：

```text
eidolon workflow init ai-data <name>
eidolon workflow init ai-ctrl <name>
eidolon workflow create "<requirement>" --form ai-data|ai-ctrl|auto
eidolon workflow edit <ref-or-path> "<instruction>"
eidolon workflow validate <ref-or-path>
eidolon workflow inspect <ref-or-path>
eidolon workflow list --scope workspace|global
eidolon workflow docs list|show|search
eidolon workflow examples list|show|export
```

后续运行期命令：

```text
eidolon workflow run <resource://fqn|path> --input <json>
eidolon workflow status <run-id>
eidolon workflow events <run-id>
eidolon workflow result <run-id>
eidolon workflow resume <run-id>
```

CLI 是 human-facing surface，不拥有 workflow core logic。

## Authority 与写入边界

AI agent 可以生成 structured workflow draft 或 graph patch，但最终写入 authority 是 workflow component：

```text
AI draft / patch
  -> parse
  -> validate resource refs and XNL bundle
  -> controlled write into workflow workspace
  -> validate
  -> optional repair loop
  -> publish or keep draft
```

这避免对话 tool、CLI 和普通文件写入工具绕过 workflow authoring contract。

## 资源系统约束

- `.eidolon` 是运行时注入的 workspace/global root。
- 业务资源身份使用 `resource://<FQN>`。
- Bundle 内部路径使用 `vfs://./...` 或 `vfs://@/...`。
- 配置和密钥引用使用 `config://...` / `secret://...`。
- 资源内容使用 XNL，不引入 XML 作为 workflow bundle authoring 格式。
- 禁止 host absolute path、裸相对路径、traversal、`file://`、`http://` 等引用。

## Effect provider

Workflow effect provider 不调用外部 CLI。执行 AI agent task 时应使用 Eidolon 已有 actor 体系承载。

Effect 类型：

- `agent_task`
- `tool_call`
- `human_input`
- `material`

如果某 effect 需要 durable evidence 或恢复，应接入 Eidolon runtime-control/effect lifecycle，而不是在 workflow 包里创建独立持久化机制。

## 受控重规划

允许在 mission 执行中重排 tracks：

- component/tool 边界如果发现与标准组件协议不一致，先更新 design/report，再修订任务。
- runtime run 如果需要更深 runtime-control 能力，切出专门 track。
- CLI create/edit 如果真实 agent actor API 不稳定，先落 deterministic init/validate/inspect/list，再把 create/edit 作为后续 track。

每次重规划必须写 reports/replan-*.md，并更新 mission.xml Revision。
