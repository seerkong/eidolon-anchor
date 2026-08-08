# 变更：建立 Eidolon Workflow 共享 Authoring Workspace

## 背景和动机 (Context And Why)

当前 workflow command service 只能返回 draft；CLI 在 terminal 层私有执行目录创建和文件写入，而对话 tool 每次无参创建 component，因此 TUI 无法获得相同的写入能力。这使两个 surface 的行为分裂，也让 CLI 意外成为 workflow resource write authority。

## 目标 (Goals)

- 在 `ai-organ-logic/src/workflow/authoring` 建立 containment-safe workspace port 与本地文件实现。
- 让 draft、validate、publish、read/tree/diff/edit/delete/search 等 authoring transition 由共享 component 拥有。
- 让对话 tools 从 runtime roots 绑定可写 component；让 CLI 注入同一种 binding，不再直接调用 `mkdir`/`Bun.write`。
- 发布前后都通过 canonical loader，并以原子文件替换完成 publish。

## 非目标 (Non-goals)

- 本 track 不实现自然语言生成/修复 actor；后续 NL track 使用这里的 authoring primitives。
- 本 track 不实现 AICtrlWorkflow 或 AIDataWorkflow runtime execution。
- 不增加 MCP adapter，也不增加新的 workflow core/parser。

## 影响 (Impact)

- `WorkflowComponent` 获得显式 authoring binding。
- `WorkflowCreateBundle` 与 CLI `workflow init` 共享真实发布路径。
- 既有低层 draft API 保留为 dry-run primitive。
