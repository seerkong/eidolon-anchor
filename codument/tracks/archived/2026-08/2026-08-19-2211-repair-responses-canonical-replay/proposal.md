# 变更：修复 Responses 完整 canonical replay

## 背景

Codex/Responses 被错误地复用了 Chat adjacency repair，导致 assistant tool call 在 tool result 到达前从 frontier 消失。随后 Responses canonical rebuild 只保留 trailing tool pair，rewind 后会造成 provider context 丢失历史读取结果并进入重复工具循环。

## 目标

- Responses 使用独立 canonical compiler，完整回放历史 tool call/output。
- frontier 在 assistant call 到 tool result 的生命周期中保持稳定。
- rewind 后旧 Responses optimization 自动失效。
- 保持 checkpoint safepoint 和 Conversation authority 不变。

## 非目标

- 不修改 Chat Completions adjacency repair 语义。
- 不添加重复工具调用阈值。
- 不修改 provider retry policy。
