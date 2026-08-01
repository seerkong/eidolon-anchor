# Acceptance: update-questionnaire-protocol-and-intake-forms

## 目标

确认问卷能力同时具备：

- 协议化的 `Q1/Q2 + A/B/C` 文本展示
- 最后一个自由填写选项
- 可解析的文本回答格式
- 不压扁的多题投影
- 更合理的推荐类 intake，至少覆盖旅行推荐

## In Scope

- `ask-multi-question-free` 协议对齐
- 多题问卷题号与选项编号
- 自由填写选项的固定末位字母策略
- 文本回答格式解析
- semantic / history / TUI questionnaire projection
- recommendation intake 策略
- travel recommendation exemplar

## Out Of Scope

- approval pane 的整体视觉重设计
- provider / model / session surfaces
- 非 questionnaire 的 permission 协议

## 自动化验收

### A1. Track 结构验收

```bash
codument validate update-questionnaire-protocol-and-intake-forms --strict
```

通过标准：

- track 严格校验通过

### A2. 问卷相关测试验收

```bash
bun run test:terminal:tui
```

通过标准：

- terminal TUI 测试通过
- 至少覆盖：
  - 多题 questionnaire 不再被压扁为单题 `q1`
  - text projection 产出 `Q1/Q2` 与 `A/B/C`
  - 最后一个自由填写选项存在
  - `q1: a ; q2: b` 可解析
  - `q3: D balabala` 可解析

## 手工功能验收

### M1. Text View 协议验收

操作：

1. 触发一个多题 questionnaire
2. 观察 text view 输出

通过标准：

- 每题显示 `Q1/Q2/...`
- 每个选项显示字母编号
- 最后一个选项保留给自由填写

### M2. 文本回答协议验收

操作：

1. 使用 `q1: a ; q2: b`
2. 使用 `q3: D 我想要安静一点`

通过标准：

- 系统正确识别题号与选项
- 自由填写文本被保留为结构化答案

### M3. Travel Recommendation Intake 验收

操作：

1. 请求旅行推荐
2. 观察首轮 questionnaire

通过标准：

- 首轮为 2-4 个高信息量问题
- 不退化成单个自由文本问题
- 问题覆盖时间/预算/同行人群/偏好中的大部分

## 最终通过条件

1. 问卷展示协议与 `ask-multi-question-free` 对齐
2. 文本回答协议可稳定解析
3. 多题结构在投影链路中保持完整
4. 旅行推荐类问卷首轮质量达到结构化 intake 水平
