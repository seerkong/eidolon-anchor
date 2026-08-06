# 变更：read 工具行为对齐 Claude Code Read 语义

## 背景和动机 (Context And Why)

当前 `read` 工具在大文件场景下效率低：模型每次只读约 200 行，因为工具 schema 没有描述默认 limit/offset 语义，模型只能按训练常见的小页面翻页；同时工具默认对文件是 2000 行、对目录是 200 条（[Read/Logic.ts:43,55](cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Read/Logic.ts:43)），同一工具两种隐式默认。模型对文件大小/总行数一无所知，无法在读取前决定合适范围。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- `read` 对齐 Claude Code Read 语义：默认 limit 2000、offset 1 起始、>2000 行文件截断到前 2000 行、`<context-resource>` header 带 `total-lines` 属性。
- 统一目录与文件默认，消除 200 vs 2000 双默认；目录读取也带 total 元信息。
- 提供文件大小/总行数元信息（方向 C），让模型先获取元信息再决定读取范围。
- 截断行为对齐 Claude Code（decision B：截断时不带行号，total-lines 在 header）。

**非目标:**

- 不改成 Codex `file_view` 的强制 `range` 参数形态（用户明确选择 Claude Code Read 语义）。
- 不新增独立配置机制（留给 Track 3 与用户配置方案）。
- 不改变 already-visible 判定（Track 2 处理）。

## 变更内容（What Changes）

- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Read/Logic.ts`：统一默认、大文件截断、目录默认对齐。
- `cell/packages/ai-organ-logic/src/runtime/LocalTextResourceLoader.ts`：`<context-resource>` header 增加 `total-lines`（文件/目录通用）。
- 提供文件 size/行数元信息入口（read 或 ls 目录工具）。
- 更新/新增 read 工具与 loader 测试。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`local-coding-tool-permission-controls`（read 权限上下文）、`progressive-context-resource-loading`（resource 输出格式上下文）
- 受影响的代码：
  - `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Read/`
  - `cell/packages/ai-organ-logic/src/runtime/LocalTextResourceLoader.ts`
  - `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Ls/`（如采用 ls 元信息方案）
