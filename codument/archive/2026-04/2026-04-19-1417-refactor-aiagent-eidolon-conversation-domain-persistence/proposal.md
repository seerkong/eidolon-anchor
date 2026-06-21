# 变更：重构 AIAgent `.eidolon` Conversation Domain Persistence

## 背景和动机 (Context And Why)
当前项目已经有 semantic-first event 链路、`depa-data-graph` 的 event log / projection foundation、`depa-actor` 的 actor/fiber runtime，以及 `.eidolon/sessions/<session>/` 下的 transcript、snapshot 与历史 session 加载能力。但这些能力仍分散在 transcript、runtime snapshot、`/compact` 注入逻辑和 session loader 之间，没有被统一成正式的 history truth、prompt truth、session lineage 主链。

这导致三个实际问题：

- 消息历史与压缩上下文仍混在同一条 `messages` 真相里
- 压缩后的 `state_snapshot` 会影响模型输入，却没有独立 prompt head
- 历史 session 加载虽然可用，但恢复语义仍偏 transcript/snapshot-first，而不是 conversation domain-first

本次 track 需要把参考方案转换成本项目可落地的版本，并明确以 `.eidolon` 文件系统持久化作为第一版正式实现，而不是仅做抽象设计。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 在 semantic 之上建立本项目版 `conversation domain graph family`
- 用 `generation / head / lineage` 重构消息历史、压缩和历史 session 加载
- 以 `.eidolon/sessions/<session>/` 作为第一版正式 conversation persistence 根目录
- 让 `.eidolon` 本地文件读写实现作为 `@cell/ai-support` 的正式 support backend side effects 落地
- 保留并吸收现有：
  - actor-scoped transcript
  - runtime snapshot / derived indexes
  - `/compact` 能力
  - 历史 session list/load
- 让历史恢复优先从新的 conversation indexes / generations 恢复，而不是继续只靠 transcript + snapshot 混合推断
- 为未来 rollback / fork / context assets / micro compact 保留标准定义与扩展位

**非目标:**
- 不把 AI-specific conversation 语义下沉到 vendor 层
- 不要求本次同时落数据库后端
- 不要求本次重写全部 TUI/Web 交互表面
- 不把 `logs/orchestration_history.txt` 提升为正式 history truth
- 不继续把压缩后的 summary + ack 视为唯一正式消息历史

## 变更内容（What Changes）
- 新建本项目版三域数据模型：
  - history generation / head / lineage
  - prompt generation / basis / transform / head
  - session lineage / actor binding / optional context asset registry
- 新建 semantic 之上的 `conversation domain graph family`
  - 逻辑上等价于参考项目的 stream family
  - 物理实现改用 `depa-data-graph` 的 append-only event log、reducer projection 与 signal
- 明确包职责：
  - `ai-organ-contract` 定义 conversation persistence contract
  - `ai-organ-logic` 负责 persistence orchestration 与 recovery/load 接线
  - `ai-support` 负责 `.eidolon` 本地 store/repository/effects 的正式实现
- 冻结 `.eidolon` 第一版正式权威落点：
  - `.eidolon/sessions/<session>/conversation/history.index.json`
  - `.eidolon/sessions/<session>/conversation/prompt.index.json`
  - `.eidolon/sessions/<session>/conversation/session.index.json`
  - `.eidolon/sessions/<session>/conversation/artifact-refs.index.json`
  - `.eidolon/sessions/<session>/conversation/history-generations/*`
  - `.eidolon/sessions/<session>/conversation/prompt-generations/*`
- 将现有 `actors/*/transcript.txt` 降级为：
  - append-only 原始消息证据
  - generation bootstrap / migration 输入
  - audit / debug 辅助
- 将现有压缩逻辑迁移为正式 conversation compaction：
  - history 域负责 seal predecessor + move head
  - prompt 域负责 compacted prompt context 与 transform chain
- 将历史 session 加载迁移为优先读取 conversation domain persistence，而不是只从 runtime snapshot 与 transcript 拼装
- 为本项目 TUI 补齐基于 `/resume` 的会话查看与恢复交互：
  - `/resume` / `/continue` / `/session` 在 TUI 中触发现有 session surface
  - 弹出可滚动 session 列表
  - 每个 session 项显示三行摘要：create/update 时间、初始用户问题、最新消息预览
  - 支持上下选择与 enter 恢复目标 session
  - 恢复后优先通过 runtime-first conversation views 展示历史

## 影响范围（Impact）
- 受影响的功能规范：
  - `aiagent-reference-aligned-stage-streaming`
  - `aiagent-persistence-recovery`
  - `aiagent-member-holon-primary-model`
  - `vendor-data-graph-stream-foundations`
- 受影响的代码：
  - `cell/packages/ai-organ-contract`
  - `cell/packages/ai-organ-logic`
  - `cell/packages/ai-support`
  - `terminal/packages/organ-support`
  - `terminal/packages/tui`
  - `terminal/packages/organ`
- 受影响的持久化目录：
  - `.eidolon/sessions/<session>/actors/*`
  - `.eidolon/sessions/<session>/runtime_state/*`
  - `.eidolon/sessions/<session>/conversation/*`
