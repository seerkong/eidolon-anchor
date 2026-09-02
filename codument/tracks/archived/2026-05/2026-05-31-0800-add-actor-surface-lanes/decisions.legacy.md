# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】conversation lane 与 scheduler lane 的边界
- 背景：本项目已有 lane，但当前 lane 主要服务 member/holon 调度；本 track 需要新增 UI/用户可选择的前台对话泳道。
- 需要决定：是否创建独立 actor surface lane contract。
- 选项：
  - A) 创建独立 `conversation_lanes` contract，与 scheduler lane 分离
  - B) 复用现有 member/holon scheduler lane
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：用户明确指出本项目已有 lane 是给 member 用的 lane，需要参考 Sparrow 新增 conversation lane / actor lane / backend identity 能力。
- 最终决策：A
- 决策理由：UI foreground lane 与调度 lane 语义不同，混用会导致 primary backend identity、member direct lane、holon scheduler lane 难以区分。
- 状态：accepted

### 2. 【P0】questionnaire pending 真相源
- 背景：delegate 子任务需要审批时，当前问题表现为审批没有进入 TUI 前台，导致 session 看起来卡住。
- 需要决定：pending questionnaire 是否提升为 runtime/session 全局队列。
- 选项：
  - A) 使用 runtime-global pending queue，按 questionnaire id 回复并路由到 owner actor/fiber
  - B) 继续保留 actor-local pending，只增强 TUI 扫描逻辑
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：用户要求参考 Sparrow 统一处理 questionnaire，并顺便修复 questionnaire 问题。
- 最终决策：A
- 决策理由：questionnaire 是人类阻塞交互，必须从当前 lane/watch 过滤中独立出来；按 id 路由到 owner actor/fiber 可以修复 delegate-local approval 不可见的问题。
- 状态：accepted

### 3. 【P1】Actor list 第一版展示范围
- 背景：Actor list 可以展示 materialized actors，也可以展示未初始化的 member/holon conversation lanes。
- 需要决定：第一版展示范围。
- 选项：
  - A) 同时展示 conversation lanes 与 materialized actor lanes，并标记 initialized 状态
  - B) 只展示 materialized actor lanes
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：用户希望 `[Actor列表]` 显示当前 actor 列表，并参考 Sparrow 同时切换 actor 或 teammate 能力。
- 最终决策：A
- 决策理由：同时展示两类 surface 更符合 Sparrow 模型，也能让 member/holon lane 在 materialize 前可被用户选择。
- 状态：accepted

### 4. 【P1】primary backend identity 配置入口
- 背景：用户希望支持配置 primary actor backend identity，但当前请求没有限定第一版 UI 入口。
- 需要决定：本 track 是否必须交付完整配置 UI。
- 选项：
  - A) 本 track 建立 contract/facade/persistence，TUI 展示当前 backend identity；完整配置 UI 可后续增强
  - B) 本 track 同时交付完整 primary backend identity 配置 UI
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：
- 最终决策：
- 决策理由：
- 状态：pending

### 5. 【P2】actor-scoped manual message 开放范围
- 背景：用户希望发现问题后能人工发送消息，再继续运行；不同 actor 类型对人工输入的语义可能不同。
- 需要决定：第一版开放范围。
- 选项：
  - A) 对 foreground-capable actor 开放，其他 actor 只允许查看和取消
  - B) 对所有 materialized actor 开放
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：
- 最终决策：
- 决策理由：
- 状态：pending

### 6. 【P0】Actor transcript 切换契约
- 背景：首轮 gap-loop 发现 Actor list 选择后只更新 selected target，主消息区仍显示 session-level `messages()`，未真正切换到目标 actor/lane 的 conversation history。
- 需要决定：actor transcript 历史应当通过什么 contract 暴露给 TUI。
- 选项：
  - A) `ActorSurfaceProjection` 只暴露 `transcriptKey` 等轻量索引，新增独立 `actor.messages({ sessionID, laneID?, actorID?, limit? }) -> MessageWithParts[]` facade
  - B) 在 `ActorSurfaceProjection` 内携带 bounded transcript preview/history payload
  - C) 继续复用 `session.messages` 并由 TUI 本地过滤
- 当前建议：A
- 用户答复：用户明确要求本迭代实现类似 Sparrow agents 的多 actor 工作台效果，而不是丐版；同时本项目交互通过底部 `[Actor列表]` 弹窗切换，不采用 Sparrow TUI 的常驻 lane row。
- 最终决策：A
- 决策理由：actor surface 需要保持轻量、可频繁 hydrate；完整 transcript 属于独立数据生命周期。独立 actor transcript facade 可以复用现有 `MessageWithParts` 渲染形状，又能避免把 surface、history、questionnaire 状态混在一起。
- 状态：accepted

### 7. 【P0】Actor 切换交互形态
- 背景：Sparrow TUI 通过独立 lane 行切换 actor；本项目底部空间和现有交互模式不同。
- 需要决定：是否新增常驻 actor lane row。
- 选项：
  - A) 不新增常驻 lane row；通过底部 `[Actor列表]` 弹窗选择 actor/lane，并在选择后切换 active transcript view
  - B) 复制 Sparrow TUI 常驻 lane row
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：用户明确说明切换交互和 Sparrow TUI 略有区别，是通过点开底部按钮的弹窗实现切换，而不是点击独立的一行。
- 最终决策：A
- 决策理由：底层能力参考 Sparrow 的 conversation lanes、actor lanes、backend identity 和 questionnaire 统一处理；前台交互遵循本项目现有 bottom bar + dialog 模式。
- 状态：accepted
