# Design：typed context fact equivalence migration

## 现状映射

```text
legacy golden
  stable system roots
  runtime_work_context system overlay
  chronological history

current production
  stable system roots
  chronological history
  ActorProviderContextFact user message at its admitted history anchor
```

旧 overlay 与新 fact 的 wire role、位置和编码不同，这是已批准的架构迁移；其中承载的 work mode/task phase 语义必须一致。除这个迁移槽外，其他消息仍由同一 Conversation materialization 语义守门。

## 设计

1. `compareProviderMessageSequences` 保持严格 wire diff，不改变通用含义。
2. 新增测试专用 migration projection：
   - 识别且只识别 `<runtime_work_context>...</runtime_work_context>` system overlay；
   - 识别 `eidolon-context-fact/v1\n` 且 JSON payload 可解析、kind/namespace 为 work context 的 user fact；
   - 从两种编码提取规范 work-mode/task-phase payload；
   - 从比较序列中取出该语义槽后，对剩余消息继续严格比较。
3. shape invariant 接受一个合法 tagged context fact 与普通 user 相邻，但 malformed、连续两个 fact、普通 user-user、错误 role 和 tool pair splitting 均失败。
4. gate 同时覆盖 legacy golden shape、production shape、migration semantic equivalence、domain source 与 determinism。

## 风险与控制

- 风险：测试 normalization 过宽掩盖真实消息漂移。
- 控制：识别函数使用精确 tag、JSON parse、明确 payload 字段；迁移槽之外仍使用原始严格 diff，并通过反例测试锁死边界。

## 兼容与迁移

不修改生产 wire。旧 golden 作为 migration baseline 永久保留；未来 context fact schema 升版必须新增显式版本映射，不能静默重录。
