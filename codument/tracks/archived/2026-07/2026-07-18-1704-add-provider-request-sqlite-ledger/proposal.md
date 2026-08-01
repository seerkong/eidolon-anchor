# 变更：新增 Provider Request SQLite 观测账本

## 背景和动机 (Context And Why)
当前重复调用问题只能通过 History、resource facts 和 diagnostics 间接推断 provider context，无法还原每次实际 provider 调用收到的完整消息顺序。需要在真实 provider attempt 边界保存独立现场，先获得事实再决定消息构建机制是否需要修改。

## "要做"和"不做" (Goals / Non-Goals)
**目标:**
- 显式启用时，把每次真实 provider attempt 的有序 messages、tools、provider-shaped request contract 和关联 identity 写入 session-local SQLite。
- 区分 logical provider call、physical attempt、retry、成功、错误和中断。
- 提供安全的 SQLite 查询现场，用于重跑指定 session 后比较连续请求。
- 观测写入失败不影响 provider 请求语义。

**非目标:**
- 本 track 不修改 Conversation/History materialization、TaskTree 或资源加载决策。
- 不把 SQLite 作为 recovery、prompt 或 continuation 输入。
- 不默认采集所有 session 的完整 prompt。
- 不尝试识别自然语言 message 内容中的所有潜在秘密。

## 变更内容（What Changes）
- 在 `ai-organ-contract` 增加 provider-specific request observation data 与 append-only port，不把该 contract 或存储放进 core 包。
- 在 provider retry 的真实 attempt 边界同步写入请求事实。
- 在 app 顶层 `terminal/organ-support` 中提供 `bun:sqlite` session ledger 和 binding factory，包含 schema、WAL、0600 权限、查询字段和失败隔离。
- 为 `eidolon exec` 增加 `--capture-provider-requests` 显式开关。
- 用目标 session 生成 SQLite 现场并据连续请求重新分析重复循环。

## 影响范围（Impact）
- 受影响的能力：`ai-runtime-observability-rx-sinks`、`terminal-headless-runtime-cli`
- 受影响的代码：`ai-organ-contract` provider contract、`ai-organ-logic` adapter、terminal app composition、`terminal/organ-support` SQLite、headless CLI 参数与测试
