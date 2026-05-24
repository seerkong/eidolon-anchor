## ADDED Requirements

### Requirement: Protocol-Aligned Multi-Question Questionnaire Presentation

系统应当（SHALL）让问卷的文本协议对齐 `codument/std/protocols.md` 中的 `ask-multi-question-free`，在多题场景下使用稳定的 `Q1` / `Q2` / `Q3` 题号与 `A` / `B` / `C`... 选项编号。

#### Scenario: Render recommendation intake as numbered multi-question form

- **GIVEN** agent 需要一次性向用户确认多个关键条件
- **WHEN** 系统生成并展示 questionnaire
- **THEN** 每个问题都带有 `Q1` / `Q2` / `Q3` 题号
- **AND** 每个候选答案都带有顺序字母编号
- **AND** 文本协议遵循 `ask-multi-question-free`

### Requirement: Always Preserve A Free-Text Option As The Last Choice

系统应当（SHALL）在带候选选项的问题中始终保留最后一个可自由填写的选项，并为它分配顺序中的最后一个字母编号。

#### Scenario: Keep a protocol-visible free-text branch for text view answering

- **GIVEN** 一个问题存在 `A` / `B` / `C` 等候选选项
- **WHEN** 系统为 text view 或 TUI 渲染该问题
- **THEN** 最后一个选项保留给用户自由填写
- **AND** 该自由填写选项拥有和其他选项相同的顺序字母编号
- **AND** 用户可以用该字母后接文本内容作答

### Requirement: Textual Questionnaire Answers Support Question Labels And Option Letters

系统应当（SHALL）接受按题号与选项字母作答的自由文本格式，而不要求用户必须逐题点击 UI。

#### Scenario: Parse compact coded answers across multiple questions

- **GIVEN** 问卷使用 `Q1` / `Q2` / `Q3` 与字母编号展示
- **WHEN** 用户输入 `q1: a ; q2: b`
- **THEN** 系统正确识别题号与选项字母
- **AND** 产生结构化 `answers`

#### Scenario: Parse free-text answers from the last option label

- **GIVEN** 某题的最后一个选项保留给自由填写
- **WHEN** 用户输入 `q3: D balabala`
- **THEN** 系统将 `D` 识别为自由填写分支
- **AND** 将 `balabala` 作为该题的文本答案保留下来

### Requirement: Questionnaire Projection Preserves Full Question Structure

系统应当（SHALL）在 semantic、history、runtime client 与 TUI projection 链路中保留完整的 `questions[]` 结构，而不是把问卷压扁成首题或单个 `text` 占位。

#### Scenario: Multi-question questionnaire survives semantic and history projection

- **GIVEN** runtime 发出包含多个问题的 `QuestionnaireRequest`
- **WHEN** 该请求经过 semantic projection、message history projection 与 TUI runtime client
- **THEN** 完整的题目数量、题号顺序、类型与选项都被保留
- **AND** TUI 不会退化为单题 `q1`

### Requirement: Recommendation Intake Uses Domain-Aware Structured Questionnaires

系统应当（SHALL）让推荐类场景优先生成领域化的结构化 intake 问卷，而不是默认退化成单个自由文本问题。

#### Scenario: Travel recommendation starts with a structured intake round

- **GIVEN** 用户请求旅行推荐或类似的行程规划建议
- **WHEN** agent 决定先发起 questionnaire
- **THEN** 系统优先生成 2-4 个高信息量问题的结构化 intake
- **AND** 问题优先使用 `single_select` / `multi_select` / `number` / `text` 的合理组合
- **AND** 不退化为单个“请描述你的需求”的自由文本问题，除非用户意图本身极度模糊

## MODIFIED Requirements

### Requirement: TUI 终端 projection 将问卷结构化数据格式化为文本

系统 MUST 通过正式的 semantic terminal projection surface 将 `QuestionnaireRequest` 的结构化数据转换为适于终端展示的格式化文本；当前 TUI 路径由 `terminal/packages/organ/src/stream/TuiProjectionGraph.ts` 消费 `semantic_questionnaire_request` 并生成可见文本。对于多题问卷，该文本格式必须对齐 `ask-multi-question-free` 协议，并保留题号、选项编号和自由填写选项。

#### Scenario: 终端可读问卷文本

- **GIVEN** 一个包含多题的 `QuestionnaireRequest`
- **WHEN** TUI 消费该事件
- **THEN** 输出包含标题、说明、`Q1/Q2/...` 题号与 `A/B/C/...` 选项提示
- **AND** 对于可自由填写的问题，最后一个选项为可填写分支

### Requirement: Shell 以文本形式展示问卷并收集用户回复

系统 MUST 在终端 shell 中显式展示问卷文本，并收集用户以文本形式的回答。对于多题问卷，系统必须接受以题号和选项字母组合的文本格式作答。

#### Scenario: 用户以协议化文本回答多题

- **GIVEN** TUI 已展示符合协议的多题问卷文本
- **WHEN** 用户输入 `Q1: A ; Q2: B` 或 `Q3: D balabala`
- **THEN** 系统将该文本交给问卷解析器
- **AND** 解析器按题号、选项字母和自由填写分支得到结构化答案
