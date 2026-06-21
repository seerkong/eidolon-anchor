# 问答协议（std/sop/questioning.md）

> 从原 `std/protocols.md` 拆出的「提问」域。skill 经 `<ask protocol="...">` 引用。

## 通则

- **只在必须澄清/选择/确认时提问**；禁止为"测试运行环境能否提问"而发占位问题。
- 当前步骤无需立即提问就直接继续。
- 优先一次问清（同一轮收集多个决策），减少往返。
- **澄清即沉淀（file-in/file-out）**：澄清过程中一旦某概念/行为/policy/架构**被澄清并稳定**，**当轮就**把它写回对应 owner 文档（`docs/modeling`/`docs/impl`，按 [knowledge-tiers.md](@codument/attractors/knowledge-tiers.md) 与 `model-driven-docs.md` 路由），不要让结论只留在对话或拖到归档。未稳定的猜测留 track，不污染 owner 文档。

## 协议

### ask-single-question-free
单个开放式问题，自由文本作答。用于：澄清范围、收集一个决策（如 track 创建时的"修改意见"）。

### ask-multi-question-free
一轮内多个开放式问题，自由文本作答。用于：同轮收集多个相关决策（如 track 创建的"修改意见 + 提交模式 + 校验模式 + 方向审查"）。

### ask-single-question-closed
单个封闭式问题，给定选项择一/择多。用于：明确的二选一/多选一（如"是否配置并行参数 A/B"）。

## 与 skill 的衔接

- skill 的 `<ask protocol="ask-single-question-free">…</ask>` 表示该步可能需要交互；执行时按本协议判断"是否真的需要问"。
- 失败处理类提问（重试/跳过/中止）也走对应封闭/开放协议。
