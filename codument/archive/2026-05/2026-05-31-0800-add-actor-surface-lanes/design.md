## 上下文
本 track 要解决的是一组同源问题：用户需要一个 shell 同时观察和操作多个 actor；primary actor 需要可配置 backend identity；delegate 或其他非当前前台 actor 触发 questionnaire 时必须进入统一的人类交互队列。当前系统已有 member/holon 和 fiber orchestration，但缺少面向 shell/TUI 的 actor surface 抽象。

## 方案概览
1. Actor surface contract
  - 新增 `ConversationLane`：面向 UI 的前台泳道，字段包括 `laneId`、`kind`、`displayName`、`backendIdentity`、`actorId?`、`initialized`、`status`、`metadata`。
  - 新增 `ActorLane`：真实 runtime actor/fiber 视图，字段包括 `actorId`、`actorKey`、`actorType`、`displayName`、`transcriptKey`、`runtimeStatus`、`activeTurnId?`、`cancellable`、`metadata`。
  - 新增 `BackendIdentity`：`kind` 支持 `primary | agent | member | holon | actor_definition`，并携带对应 id/name/governance/agent definition。
  - 新增 `ActorSurfaceProjection`：聚合 `conversationLanes`、`actorLanes`、`selectedLaneId`、`selectedActorId`、`questionnaireSurface`。

2. Primary backend identity
  - `lane:primary` 是稳定 foreground lane。
  - primary lane 的 concrete actor 仍是 primary actor。
  - `backendIdentity` 独立表达被 primary 使用的能力身份，可以指向 agent/member/holon。
  - primary backend identity 的配置和恢复进入 runtime/session truth，而不是只保存在 TUI local state。

3. Member/holon conversation lanes
  - member/holon 现有 scheduler lane 不改名、不复用为 UI lane。
  - conversation lane 使用新的 lane id 约定，例如 `lane:member:<memberId>`、`lane:holon:<holonId>`。
  - lane 可在没有 concrete actor 时展示为 uninitialized。
  - 用户向 uninitialized lane 发送消息时，由 facade 显式 materialize/bind actor，再投递 human input。

4. Runtime-global questionnaire surface
  - pending questionnaire 进入 session/runtime 全局索引，key 为 `questionnaireId`。
  - 每个 pending entry 记录 owner actor id、owner fiber id、session id、tool call id、request payload、suspend policy、lifecycle state。
  - TUI hydrate 和实时事件都消费该全局 surface；questionnaire request 不受 watched actor 或 selected lane 过滤影响。
  - 回复时使用 `questionnaireId`，runtime 查 pending entry 后向 owner actor/fiber 发送 result/resume signal。

5. Shell/runtime facade
  - 增加窄接口：
    - `getActorSurface()`
    - `selectActorSurfaceTarget(laneId | actorId)`
    - `sendActorHumanMessage(laneId | actorId, text)`
    - `cancelActorTurn(actorId, turnId?)`
    - `submitQuestionnaireResponse(questionnaireId, responseText)`
  - TUI 不直接扫描 actor mailbox、orchestrator internals 或 member/holon registry 作为真相源。
  - Facade 返回更新后的 projection 或发出足够的 runtime event 供 TUI graph 更新。

6. TUI Actor list
  - bottom bar 将 `[使用说明]` 移入 `[功能菜单]`。
  - 新增 `[Actor列表]` 按钮，打开标准 dialog。
  - Dialog 展示 conversation lanes 和 materialized actor lanes，可标记 selected、busy、waiting questionnaire、cancellable。
  - 选择项后切换当前查看 transcript；可对该 actor 执行 cancel 或手工发送消息。
  - 本项目不复制 Sparrow TUI 的常驻 lane row 交互；多 actor 切换统一通过底部 `[Actor列表]` 弹窗完成。
  - 本迭代目标是交付接近 Sparrow 的多 actor 工作台能力，而不是只展示 actor surface：选择 actor/lane 后主消息区必须切换到对应 transcript，composer 必须路由到当前目标，questionnaire 仍保持全局可见。

7. Actor transcript view
  - `ActorSurfaceProjection` 只承载轻量索引和状态：lane、actor、backend identity、`transcriptKey`、selected target、cancelability、questionnaire surface。
  - 完整 transcript 不放入 actor surface，避免频繁 surface hydrate 携带大历史。
  - Runtime facade 新增独立 actor transcript hydration port，例如 `actor.messages({ sessionID, laneID?, actorID?, limit? }) -> MessageWithParts[]`。
  - `actor.messages` 根据 actor id 或 conversation lane 解析具体 actor transcript；未初始化 lane 返回空历史，不隐式 materialize。
  - TUI graph 增加 active transcript view 概念，按 transcript key 缓存/切换消息投影；`session.messages` 仍表示 session/main projection。
  - Actor list 选择后先调用 `actor.select` 更新目标，再调用 `actor.messages` hydrate 当前 view。
  - 第一版实时同步可在 select/send/cancel/status idle 后显式 rehydrate；若后续需要跨 actor 流式增量精确合并，runtime message events 应携带 actor/transcript identity。

## 影响范围与修改点（Impact）
- Contract/model:
  - actor surface projection types in the core/runtime contract layer.
  - questionnaire pending entry type with owner actor/fiber metadata.
- Runtime/organ:
  - actor surface builder.
  - primary backend identity persistence and restore.
  - questionnaire pending global index and reply router.
  - facade commands for actor scoped input/cancel.
- TUI:
  - runtime client hydration shape.
  - bottom bar buttons and feature menu.
  - Actor list dialog and transcript target switching.
  - questionnaire center data source.
- Tests:
  - runtime facade tests.
  - questionnaire bridge tests.
  - TUI dialog and bottom bar tests.
  - actor scoped cancellation tests.

## 决策摘要
- 详见 `decisions.md`。
- 当前关键结论：
  - actor surface lane 与 scheduler lane 分离。
  - questionnaire 使用 runtime-global pending queue。
  - primary foreground lane 与 backend identity 分离。
  - TUI Actor list 复用现有 dialog 风格。

## 风险 / 权衡
- 风险：同时引入 lane、questionnaire、TUI 交互，范围较大。
  - 缓解：分阶段实现，先 contract/facade，再 questionnaire 修复，最后 TUI。
- 风险：primary backend identity 与 member/holon direct lane 容易混淆。
  - 缓解：测试覆盖 `lane:primary` 指向某 member 时，不激活 `lane:member:<id>`。
- 风险：全局 questionnaire queue 与现有 history/projection 重叠。
  - 缓解：pending queue 做生命周期真相，history/projection 只做展示合并。
- 风险：actor-scoped cancel 可能误取消其他 actor。
  - 缓解：cancel command 必须带 actor id，优先使用 active turn identity，测试覆盖多 actor 并发。

## 兼容性设计
- 保留现有 questionnaire request/result schema，新增 owner metadata 和 global surface projection。
- 旧 TUI questionnaire center 继续存在，但数据来源切换为全局 surface。
- Existing member/holon scheduler lane names stay valid and are not repurposed.
- Existing `[功能菜单]` remains the menu root; usage guidance becomes a menu item.

## 迁移计划
1. 添加 actor surface contract 与 facade 空实现/最小 projection。
2. 将 primary actor、现有 materialized actors 投影为 actor lanes。
3. 加入 backend identity persistence and projection。
4. 建立 global questionnaire pending queue and owner-routed reply.
5. 切换 TUI hydrate/questionnaire center to the new surface.
6. Add Actor list dialog and bottom-bar menu changes.
7. Remove obsolete direct control-actor questionnaire checks once regression tests pass.

## 待解决问题
- 是否需要第一版支持配置 primary backend identity 的 UI，还是只建立 contract/facade 并通过配置读取。
- Actor-scoped manual message 是否对 detached actor 默认开放，还是先限制为 foreground-capable actor。
