# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由。
- 问题标题不用字母前缀；字母只用于选项。
- 后续执行过程中出现的新决策，也继续追加到本文件。

### 1. 【P0】高频 idle hook 的调度模型
- 背景：`actor.idle.before` 会是 AI agent 高频扩展点，可能同时存在 goal continuation、memory flush、coordination、diagnostics 等 hook。
- 需要决定：多个 idle hook 在同一 idle cycle 中如何编排。
- 选项：
  - A) 同步串行、确定性排序、每个 hook 前重检 idle snapshot。
  - B) 并行执行多个 idle hook，然后合并 effects。
  - C) 只允许一个 idle hook，其他能力必须挂在它后面。
- 当前建议：A。
- 用户答复：
- 最终决策：
- 决策理由：A 最符合 actor mailbox 与 runtime 串行 mutation 边界。B 容易让多个 hook 基于同一旧 snapshot 同时 resume/enqueue。C 会把扩展点退化成新的中心特例。
- 状态：pending

### 2. 【P0】hook contract 的首轮归属
- 背景：项目吸引子中有 platform kernel 与 AI domain kernel 两层。hook runtime 长期可能是 platform 能力，但本需求当前只针对 AI agent 生命周期。
- 需要决定：本轮生命周期 hook contract 放在哪一层。
- 选项：
  - A) 首轮放入 AI domain assembly contract，由 `ai-organ-logic` 执行 producer/dispatcher，mod 通过 manifest/extension `hooks` 字段贡献 hook，未来有跨领域复用证据后再下沉 platform。
  - B) 立即放入 platform contract，做成全领域通用 hook runtime。
  - C) 只放在 `ai-organ-logic` 内部，不进入 manifest/profile assembly。
- 当前建议：A。
- 用户答复：
- 最终决策：
- 决策理由：A 符合避免过度设计，同时保持 manifest/profile 装配；B 容易为假想复用扩大范围；C 不符合 extension first-class 目标。
- 状态：pending

### 3. 【P1】background pump 在 goal hook 化后的角色
- 背景：当前 goal continuation 由 background pump 间接触发。hook 化后需要避免丢失无前台 turn 的 idle 触发。
- 需要决定：是否保留 background pump。
- 选项：
  - A) 保留为 watchdog/drain fallback，但不直接调用 goal continuation。
  - B) 完全移除 background pump，只依赖 interactive turn finished 事件。
  - C) 保持现状，background pump 继续直接调用 goal continuation。
- 当前建议：A。
- 用户答复：
- 最终决策：
- 决策理由：A 既修正 goal hardcode，又避免恢复 session 后没有前台 turn 时丢失 idle 检测。B 风险较高。C 无法达成本 track 目标。
- 状态：pending

### 4. 【P0】hook dispatcher 的标准组件调用方式
- 背景：项目吸引子要求标准化组件封装，现有工具 handler 大量通过 `depa-processor` 的 `runByFuncStyleAdapter` 调用。
- 需要决定：hook dispatcher 调用 hook handler 时是否也必须走标准组件封装。
- 选项：
  - A) 必须使用 `runByFuncStyleAdapter` 调用 hook handler。
  - B) dispatcher 直接调用普通 handler 函数。
  - C) 两种都支持，由 hook 自己选择。
- 当前建议：A。
- 用户答复：用户明确要求 hook 机制中的 dispatcher 应使用 `depa-processor` 的 `runByFuncStyleAdapter`。
- 最终决策：A。
- 决策理由：A 符合 std-component-encapsulation 与现有工具调用模式，避免 hook 形成第二套不标准的 handler 调用路径。
- 状态：accepted

### 5. 【P0】hook point 与 result contract 是否对齐 Sparrow
- 背景：Sparrow 现有 hook runtime 使用 `point` 字符串、`mode`、`action`、`HookInvocationContext` 与 `hook_dispatch_report`，而不是枚举式 lifecycle event type。
- 需要决定：本项目新增 hook 机制是否沿用该 contract 形状。
- 选项：
  - A) 对齐 Sparrow：point 使用 `domain.action.phase` 字符串，mode 使用 `observe/transform/decision/around`，action 使用 `continue/replace/deny/ask/retry/stop`，diagnostic 使用 `hook_dispatch_report`。
  - B) 另行定义 TypeScript 枚举式 lifecycle event type，例如 `runtime_idle`。
  - C) 同时支持两套模型。
- 当前建议：A。
- 用户答复：用户要求重新阅读 Sparrow hook 事件类型和相关设计理念并更正当前设计。
- 最终决策：A。
- 决策理由：A 能复用 Sparrow 已验证的扩展语义，避免把 hook 退化成零散 lifecycle callback，也避免本项目出现第二套不兼容 hook 语言。
- 状态：accepted

### 6. 【P1】本项目既有散点 hooks 的处理方式
- 背景：本项目已有 provider scene capture、conversation persist、executor test hooks、depa-actor recovery/scheduler hooks 等局部 hook/callback。
- 需要决定：统一 hook runtime 首轮是否直接吞并这些入口。
- 选项：
  - A) 首轮记录和桥接边界，只把 goal idle continuation 接入正式 hook runtime；既有散点 hooks 保持原语义，后续逐步迁移。
  - B) 首轮全部迁入统一 hook dispatcher。
  - C) 忽略既有散点 hooks。
- 当前建议：A。
- 用户答复：
- 最终决策：
- 决策理由：A 风险可控，也符合避免过度设计。B 范围过大，容易破坏 provider/conversation/vendor 现有职责边界。C 会导致新设计和旧入口长期混乱。
- 状态：pending
