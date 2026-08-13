# Mission Design

## 控制目标

Desired state：

- Eidolon 中存在一个 AI Workflow native component，负责 workflow command/query、受控 authoring 和 runtime lifecycle。
- 对话 tools、TUI 与 `eidolon workflow` CLI 都是同一 component 的不同 surface。
- depa-flows packages 拥有 AI workflow、Ctrl flow 与 Data flow 的语义；Eidolon 不实现平行 parser 或 scheduler。
- Workflow execution 复用 Eidolon actor/session/runtime-control；workflow 层只记录 workflow facts。
- Resource authoring 使用 canonical XNL bundle 和安全 resource ref，物理根由 Eidolon runtime 注入。

Feedback / drift：

- 发现 actor/session/runtime-control API 不足时，补强其通用能力，不在 workflow 层创建特例 store。
- 发现 resource bundle 标准变化时，先同步 contract 与 depa-flows loader，再调整 tools/CLI。
- 任一 surface 出现私有 parser、runtime、fact store 或文件写入路径时，必须回到共享 component 边界收敛。
- 真实 TUI/CLI journey 与产品目标不一致时，以可执行 E2E 证据驱动重规划。

## 产品能力顺序

```text
workflow product contracts
  -> authoring lifecycle and isolated VFS sessions
  -> run, fact and Material lifecycle
  -> architecture-boundary audit
  -> human product experience
  -> installed TUI/CLI and recovery acceptance
```

## 组件分层

```text
depa-flows AI workflow core
  -> Eidolon workflow resource loader + authoring workspace
       -> bound WorkflowComponent / command-query services
            -> natural-language authoring and fulfillment actors
            -> conversation tools
            -> TUI and workflow CLI
  -> WorkCtrlFlow / EagerDataFlow runtime
       -> Eidolon actor/tool/human/material effect adapters
       -> Eidolon session/runtime-control facts
```

## 目标目录布局

```text
cell/packages/ai-workflow-contract/

cell/packages/ai-organ-logic/src/workflow/
  authoring/
  component/
  effects/
  prompts/
  resources/
  runtime/
  tools/

terminal/packages/organ-support/src/workflow.ts
terminal/packages/cli/src/commands/workflow.ts
terminal/packages/tui/
```

## Component binding 与 authoring adapter

`WorkflowComponent` 由 runtime composition 注入：

- workflow roots / resource identity resolver；
- containment-safe filesystem/resource store；
- isolated authoring session store；
- canonical depa-flows loader/validator/dry-run facade；
- Eidolon actor effect/runtime fact adapter。

TUI 与 CLI 只负责选择 workspace/global roots 和 surface policy，然后取得相同 binding。模型通过 `WorkflowWorkspace` 修改 `/work`；发布由 component 对当前 revision 执行原子 transition。任意修改都会使旧 validation 与 dry-run proof 失效。

## 高层自然语言入口

`WorkflowFulfill` 是普通用户入口，协调：

```text
business request
  -> direct / AI Ctrl / AI Data / composite route
  -> installed context and smallest starting fact
  -> one recoverable authoring session
  -> diff -> validate -> dry-run -> repair
  -> independent publication confirmation
  -> input and Material inference
  -> Instance and execution preview
  -> independent execution confirmation
  -> durable result or wait state
```

低层 tools 是 actor primitives，不是用户前置知识。正常结果只报告业务目的、进度、待确认事项、等待和最终结果。

## Runtime facts 与 effect authority

- Workflow definition revision、Instance、Run descriptor、RunGraph、节点结果、GraphPatch 和 workflow receipts 属于 workflow facts。
- Actor identity、session、mailbox、durable heads、tool/effect lifecycle 与 conversation state 属于 Eidolon runtime authority。
- Run 冻结 definition revision、input 与 Material bindings；恢复和回放不依赖 mutable latest 或 host path 猜测。
- AIDataWorkflow 的复用范围为 run-local；machine node 默认 `semantic-hash`，人工节点默认 `never`，节点可显式覆盖并记录策略来源。

## 公开 surface

Eidolon 场景只提供 native tools、TUI 和 CLI，不提供 MCP。CLI 支持普通位置参数及标准 stdin heredoc：

```bash
eidolon workflow agent - --session <session> <<'PROMPT'
多行自然语言业务目标
PROMPT
```

相同 session 可以由独立 CLI 进程依次完成草案、发布确认和执行确认。
