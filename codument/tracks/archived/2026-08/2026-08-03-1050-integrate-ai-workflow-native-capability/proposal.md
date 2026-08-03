# 变更：Integrate AI Workflow Native Capability

## 背景和动机 (Context And Why)

depa-flows 已经提供 AI Ctrl Workflow 与 AI Data Workflow 的 TypeScript library 能力，并完成 Eidolon integration boundary 设计。Eidolon 侧还缺少 native contract、tool/effect directory、composer/kernel registration，因此 agent 还不能通过 Eidolon native tool chain 直接使用新的 AI workflow 能力。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 新增 Eidolon-side workflow contract package，声明 workflow-owned facts 与 refs。
- 新增 `ai-organ-logic/src/workflow/tools` native workflow tool bundle。
- 新增 `ai-organ-logic/src/workflow/effects` 内部 effect adapter 入口。
- 让 AIAgent composer 和 `mod-ai-kernel` 能把 workflow tools 纳入 native registry/tool schema。
- 添加测试证明 workflow tools 可见、可调用，且 resource refs 有安全校验。

**非目标:**

- 不在本 track 完整实现 depa-flows runtime scheduler 的所有节点执行。
- 不复制 actor/session/conversation/tool/provider/runtime-control/checkpoint state。
- 不把 internal workflow effects 直接暴露为 model-visible tools。
- 不把实现放到 `composer/AIAgent/tools`。

## 变更内容（What Changes）

- 新增 `cell/packages/ai-workflow-contract`。
- 更新 `cell/tsconfig.json` package alias。
- 更新 `ai-organ-logic` package dependency and exports。
- 新增 workflow native tools and tests.
- 更新 AIAgent builtin/composer tool registration.

## 影响范围（Impact）

- 受影响的能力（behaviors）：`eidolon-ai-workflow-native-capability`
- 受影响的代码：
  - `cell/packages/ai-workflow-contract`
  - `cell/packages/ai-organ-logic/src/workflow`
  - `cell/packages/ai-organ-logic/src/composer/AIAgent`
  - `cell/packages/mod-ai-kernel`
  - `cell/tsconfig.json`
