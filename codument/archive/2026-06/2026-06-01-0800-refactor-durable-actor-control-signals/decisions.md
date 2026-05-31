# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由。
- 问题标题不用字母前缀；字母只用于选项。
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的过程决策记录。

### 1. 【P0】durable control signal 的归属
- 背景：fiber wake/resume/interrupt 需要 durable 化，恢复时必须能重放。
- 需要决定：控制事件主真相应存放在哪里。
- 选项：
  - A) Session-scoped control event store，绑定 VM，可被所有 actor/fiber 共享读取。
  - B) Actor durable state 内嵌 control inbox/outbox，每个 actor 自治恢复。
  - C) VM durable subset 内直接保存全局 control signal log。
- 当前建议：A。它最贴合 session-scoped runtime truth，并避免 actor state 过度膨胀。
- 用户答复：A
- 最终决策：A
- 决策理由：control event store 是 session/VM 级真相源；每条 signal 通过 actorKey/fiberId 精准归属到 actor/fiber，actor 只保存 mailbox/projection/cursor，避免多个 actor 自带 event store 造成跨 actor 恢复和幂等去重复杂化。
- 状态：accepted

### 2. 【P0】mailbox enqueue 与 resume 的统一边界
- 背景：当前 split-brain 风险来自 `actor.send(...)` 和 `resumeFiber(...)` 分离。
- 需要决定：是否强制所有 unblock/interrupt-capable 消息使用统一 API。
- 选项：
  - A) 强制使用统一 `emitFiberSignal` 类 API，禁止新增裸 `actor.send + resumeFiber`。
  - B) 仅在关键 async completion 路径使用统一 API，普通路径暂不限制。
  - C) 保留现状，只补 recovery heuristic。
- 当前建议：A。根治需要机制收口，不应继续依赖调用方纪律。
- 用户答复：A
- 最终决策：A
- 决策理由：所有 unblock/interrupt-capable completion 都必须先成为 durable control signal，再统一完成 mailbox enqueue 与 scheduler readiness 更新，避免继续出现 `actor.send` 成功但 `resumeFiber` 丢失的 split-brain。
- 状态：accepted

### 3. 【P0】running actor 收到 interrupt 的语义
- 背景：cancel 需要高优先级，但 actor handler 不能并发重入。
- 需要决定：interrupt 如何打断 running actor。
- 选项：
  - A) 入 control mailbox，同时设置 interrupt flag 并 abort 当前 abortable in-flight work，在 safe boundary 处理。
  - B) 立即并发执行一个高优先级 handler。
  - C) 只排队等待当前任务自然结束。
- 当前建议：A。它保留 actor 单线程语义，同时给 cancel 足够实时性。
- 用户答复：A
- 最终决策：A
- 决策理由：interrupt 不重入 actor handler；它进入 control mailbox，同时设置 interrupt flag 并 abort 当前可中断 work，由 actor 在 safe boundary 处理。
- 状态：accepted

### 4. 【P1】snapshot invariant 的 rollout 方式
- 背景：直接 fail 可能影响旧 session，但静默保存坏状态会继续制造停住现场。
- 需要决定：invariant 初期如何生效。
- 选项：
  - A) 先 warn + diagnostic + repair hint，测试稳定后升级为 fail-or-repair。
  - B) 首次实现即严格 fail。
  - C) 永远只 warn。
- 当前建议：A。兼顾安全迁移与最终严格性。
- 用户答复：B
- 最终决策：B
- 决策理由：本 track 目标是消除会话静默保存不可恢复 suspended 状态；实现阶段允许先用 focused test 锁定严格 invariant，再按必要的 legacy fallback 明确修复旧 snapshot，而不是继续保存坏状态。
- 状态：accepted

### 5. 【P1】提交与验证模式
- 背景：该 track 是跨模块控制面改造，需要阶段性验证。
- 需要决定：执行时的提交和验证策略。
- 选项：
  - A) manual commit + final phase gap loop。
  - B) auto commit + final phase gap loop。
  - C) manual commit + human confirm。
- 当前建议：A。该改造风险较高，建议用户控制提交，最后由 fresh gap-loop 做独立验证。
- 用户答复：A
- 最终决策：A
- 决策理由：跨模块控制面改造保持手动提交，最后通过 final phase gap loop 做独立验证。
- 状态：accepted
