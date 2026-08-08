## 上下文

本 track 是 mission `establish-eidolon-ai-workflow-native-component-and-cli` 的 G2 落地 track，目标是先建立 workflow native component/service 和对话内 tools。CLI 与 runtime run 接入分别由后续 track 处理。

## 方案概览

1. 建立共享 workflow component/service
   - `WorkflowQueryService`：inspect capability、validate resource ref、inspect bundle。
   - `WorkflowCommandService`：create bundle draft、patch bundle draft。
   - `WorkflowComponent`：组合 query/command service，并作为 tools/CLI 的共同入口。
2. 复用现有标准化 tool 封装协议
   - 每个 tool 保持 `OuterTypes` / `InnerTypes` / `Logic` / `index` / prompt XNL 结构。
   - Core Logic 只调用 component/service，不直接散落 contract helper。
3. 新增 authoring tools
   - `WorkflowCreateBundle`：根据 form/name/fqn 生成受控 XNL bundle draft，返回结构化 JSON。
   - `WorkflowPatchBundle`：接受 manifest ref + patch text / replacement content，先验证 refs，返回结构化 patch evidence。第一阶段可以只生成可写入计划，不直接改宿主文件。
4. 保持 no-MCP 边界
   - 只注册 Eidolon native tools。
   - 不新增 MCP server、MCP tool registry 或 MCP adapter。

## 影响范围与修改点（Impact）

- `cell/packages/ai-organ-logic/src/workflow/component/`
- `cell/packages/ai-organ-logic/src/workflow/tools/`
- `cell/packages/ai-organ-logic/src/workflow/index.ts`
- 相关 workflow tests

## 决策摘要

- 详见 `decisions.xnl`。
- Component/service 是工具和未来 CLI 的共享 authority boundary。
- 本 track 的 authoring tool 第一阶段返回受控 bundle draft / patch evidence；最终物理写入是否放入 tool runtime 或 CLI runtime，可由后续 track 根据 runtime capability 再接入。

## 风险 / 权衡

- 风险：直接在 tool 中写文件会绕过 resource authoring authority。
  - 缓解：第一阶段 command service 生成 structured draft/evidence；后续 CLI 或 tool write adapter 必须显式走 component transition。
- 风险：component 命名与后续 depa-flows package API 不完全一致。
  - 缓解：保持 service 输入输出小而稳定，后续可把内部实现替换成 depa-flows library adapter。

## 待解决问题

- 后续 CLI track 决定物理 workspace 写入 adapter 的最终位置。
- 后续 runtime track 决定 run/status/events/result/resume 如何映射到 Eidolon actor/session/runtime-control。
