# Design: update-questionnaire-protocol-and-intake-forms

## 目标

把当前问卷能力从“能问能答，但协议松散、模板贫弱、投影压扁”提升到“协议稳定、文本可答、推荐类 intake 合理、TUI 与 text view 一致”。

本 track 不是单独修一个组件，而是一次性修复四段链路：

- 问卷生成策略
- 文本问答协议
- semantic / history / runtime client 投影
- TUI / text view 展示一致性

## 当前问题

### 1. 问卷生成质量不稳定

虽然 `Questionnaire` 已支持 `text` / `yes_no` / `single_select` / `multi_select` / `number` / `json`，但当前推荐类任务仍经常生成一个自由文本问题。这会让“旅行推荐前置确认”看起来不符合常理。

### 2. 文本协议缺少稳定编号

`codument/std/protocols.md` 已经定义了 `ask-multi-question-free`：

- 多题
- `Q1/Q2/...`
- `A/B/C/...`
- 最后一个为自由填写

但当前问卷链路没有系统性地对齐这个协议，用户难以自然地写出 `q1: a ; q2: b` 这样的回答。

### 3. semantic / history 投影把问卷压扁

当前实现中：

- `SemanticRuntimeSupport` 只从第一题推导 `input_kind` 与 options
- `MessageHistoryGraph` 又把投影固定重建为单个 `q1`

结果是多题问卷在 UI 中退化成单题文本占位，直接破坏推荐类表单体验。

### 4. 回答解析仍偏“自由文本再猜”

当前 `parseQuestionnaireAnswer()` 主要依赖 LLM 把用户自由文本解析为 JSON。它缺少对 `Q1: A ; Q2: B` 这种协议化回答的强约束支持，也没有把“最后一个字母代表自由填写分支”变成明确规则。

## 设计原则

### 1. 协议先于 UI

先固定问卷协议，再让 TUI、text view、history、parser 对齐。不要继续让每层自己“猜”问卷该怎么显示。

### 2. 保留结构化原始真相

从 `QuestionnaireRequest.questions[]` 到 semantic、history、runtime client、TUI，必须尽量保留完整结构，不允许中途只保留首题。

### 3. 推荐类 intake 优先结构化

对于旅行推荐、路线建议、消费决策等场景，默认策略应是 2-4 个高信息量问题的一轮表单，而不是单个“请描述更多信息”的 text。

### 4. 文本回答必须是人工可写、人工可读的

用户应能在 text view 模式下直接写：

```text
q1: a ; q2: b
q3: D 想要安静一点、不要太商业化
```

这意味着协议、投影和 parser 必须共享同一套编号与自由填写语义。

## 方案概览

### 1. 引入统一的 questionnaire presentation protocol

为问卷展示增加一层稳定的 presentation contract：

- 题号：`Q1` / `Q2` / `Q3`
- 选项编号：`A` / `B` / `C`...
- 若题目允许自由填写，则最后一个选项固定为自由填写分支，并使用顺序中的最后一个字母

这层协议应同时用于：

- TUI textual projection
- text view / terminal projection
- runtime client 中的 question request 归一化
- parser 的文本答案识别

### 2. 保持完整 questions[] 贯穿投影链路

需要修正 semantic / history projection，使其传递完整问题数组，而不是只保留第一题的 `input_kind` 与 options。

最低要求：

- 每题 `id`
- 每题 `prompt`
- 每题 `type`
- 每题 `choices`
- 每题 `required`
- 题目原始顺序

### 3. 为 parser 增加协议化快速路径

`parseQuestionnaireAnswer()` 不应只依赖“自由文本 -> LLM 猜 JSON”，而应增加协议化快速路径：

- case-insensitive 识别 `q1:` / `Q1:`
- 支持 `;` 或换行分隔
- 支持 `Q1: A`
- 支持 `Q3: D 用户补充文本`

当命中协议化格式时，应优先走规则解析，再做类型校验；只有不命中协议时才回退到 LLM 解析。

### 4. 为推荐类场景引入 intake 策略

对“推荐/规划/决策前确认信息”的 agent 行为增加策略收敛：

- 优先生成 `kind=form` 或 `kind=clarification` 下的结构化多题问卷
- 首轮控制在 2-4 题
- 旅行推荐至少覆盖：
  - 时间/天数
  - 预算
  - 同行人群
  - 偏好/限制

这一步不要求一次做成完整“所有领域模板库”，但至少先把 travel recommendation 这一类高频场景拉正。

## 关键决策

### 决策 1：自由填写选项始终作为最后一个字母选项暴露

理由：

- 这与 `ask-multi-question-free` 一致
- 能直接支持 `Q3: D balabala`
- text view 和 interactive TUI 可以共享一套心智

### 决策 2：多题问卷必须完整投影，禁止在中间层降级为单题

理由：

- 单题压扁是当前 UI 失真的根因
- 只要保留完整结构，TUI / textual / history 都能各自按需展示

### 决策 3：文本答案解析优先走规则，再回退 LLM

理由：

- 规则化答案更稳定
- 更适合 text view
- 可减少“你是谁”这种输入被当作模糊自由文本后二次猜测的歧义

## 风险与取舍

### 风险 1：协议层和原始 Questionnaire schema 冲突

缓解：

- 原始 schema 保持 `questions[]`
- presentation protocol 作为展示/解析层，不要求底层 runtime schema 直接变成 `Q1/A/B/C`

### 风险 2：推荐类模板过窄，导致系统只会问旅行

缓解：

- 本 track 先定义“recommendation intake strategy”与 travel exemplar
- 设计上保留后续扩展到餐厅、购车、选学校等领域的空间

### 风险 3：parser 双路径导致实现分叉

缓解：

- 规则解析只负责协议化答案
- 类型校验仍统一走现有 validation 逻辑
- 非协议输入继续回退 LLM parser

## 测试策略

自动化测试至少覆盖：

1. 多题问卷在 semantic / history / runtime client 中不再压扁
2. text view / terminal projection 输出 `Q1/Q2` 与 `A/B/C/...`
3. 最后一个自由填写选项始终存在并拥有字母编号
4. parser 支持 `q1: a ; q2: b`
5. parser 支持 `q3: D balabala`
6. 旅行推荐场景优先生成 2-4 题结构化 intake，而不是单个 text

手工点验至少覆盖：

- TUI 中的多题 questionnaire
- text view 中的协议化作答
- 旅行推荐问卷首轮质量
