# Mission：强制 Provider Context 架构边界

## 背景和动机

Eidolon 的 Conversation authority、OpenAI Chat projection、OpenAI Responses native replay 和 Responses checkpoint optimization 目前存在可误用的共享入口。最近的回归证明：将 Chat adjacency repair 复用到 Codex/Responses 后，会让 checkpoint frontier 在 assistant tool call 尚未收到结果时发生变化；Responses canonical rebuild 又只保留最后一个 tool pair，最终导致模型反复读取文件。

用户 rewind、长任务 mandatory continuation 和 safepoint-only checkpoint 进一步放大了这个问题：旧 checkpoint 失效后，fallback projection 的不完整性直接变成长期重复工具循环。

这是跨多个 track 的架构治理目标，不能只靠单个 bug fix 收口。

## 目标

- 建立唯一、完整、无损的 Responses canonical replay compiler。
- 让 Chat wire projection 与 Responses native projection 在类型、目录、import 和命名上硬隔离。
- 让 provider send 前必须通过 projection coverage proof，禁止静默丢弃历史 tool call/output。
- 让 rewind/fork/history-head movement 显式推进 context epoch，使旧 checkpoint 和 continuation 自动失效。
- 证明 checkpoint 只是可删除优化：关闭 checkpoint 不得改变 provider-visible 语义。
- 用架构 conformance、property tests 和历史 session 验证防止同类回归。

## 非目标

- 不引入基于 work mode、工具名称、任务类型或重复次数的通用熔断阈值。
- 不改变 Conversation/History/Session 的 canonical authority。
- 不放宽 full VM snapshot 的 safepoint-only 约束。
- 不将 Responses native checkpoint 变成新的恢复真源。
- 不在 mission 中直接实现代码；实际代码、测试和行为落地由 TrackLink 指向的 tracks 承担。

## 成功判据

- 任意 Responses canonical request 都能给出 source history head、tool call/output coverage 和显式 drop reason proof。
- Chat projection 代码无法被 Responses projection import；错误复用在架构测试或类型检查阶段失败。
- rewind 后旧 checkpoint 不会影响新 history head 的 provider context。
- 100+ tool rounds、compaction、parallel calls、rewind、mandatory continuation 和恢复场景下，模型看到的 provider context 不丢失已提交历史。
- 关闭 checkpoint optimization 后的 provider semantic input 与启用 checkpoint 后等价。
- 历史问题 session 不再进入“tool 执行成功但 provider context 只含最后一对 tool pair”的循环。
