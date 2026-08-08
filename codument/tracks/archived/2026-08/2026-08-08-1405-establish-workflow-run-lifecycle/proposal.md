# Proposal: establish workflow run lifecycle

## 目标

在 Eidolon 中建立完整 workflow 产品协议：已发布资源先形成可寻址 Type，Type 创建冻结 definition revision 的 Instance，Instance 在独立 execution confirmation 后创建 Run。Run、等待、恢复与 replay 都读取冻结 facts；Material 使用 immutable revision、精确 binding 和 receipt。

## 范围

- Resource Tree inspect/validate/resolve 的运行前查询。
- Type、Instance、Session/Run descriptor、input facts 与 stable idempotency。
- 未确认预览、确认 start、等待 resolve/reject、status/events/result 与 fresh-runtime recovery。
- Material import/inspect/bind/export/replay/cleanup、manifest/provenance、lease 与 run receipt。
- 同一 native component 向 conversation tools 与 CLI 投影。

## 非范围

- 不实现 MCP surface。
- 不改变 depa-flows 的 AICtrlWorkflow、AIDataWorkflow 语义或自行实现 flow runtime。
- 不复制 Eidolon actor/session/effect evidence；workflow 只保存 workflow facts 与对这些 facts 的稳定引用。
- 不在本 track 做 acceptance 之后的自然语言体验增强。

## 成功标准

完整 run/material 场景可由产品 fixtures 执行；definition 后续修改、Material 后续 rebind 和进程重建均不改变既有 Run 的精确语义；CLI 与对话 tools 不存在 direct-run 或私有写入旁路。
