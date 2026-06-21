# 变更：更新问卷协议与 intake 表单体验

## 背景

当前 `Questionnaire` 能力已经打通了“提出问题 -> 用户回答 -> runtime 继续执行”的主链，但在真实使用中暴露出三类明显问题：

- 推荐类场景（例如旅行推荐）仍经常退化为单个自由文本问题，不像正常的前置 intake
- text view / 终端投影缺少稳定的题号与选项编号协议，用户无法自然地写出 `Q1: A ; Q2: B` 这类回答
- semantic / history / TUI projection 会把多题问卷压扁成单题 `q1 + text/choice`，导致 UI 和文本协议都失真

这不是单个 UI bug，而是问卷协议、生成策略、投影链路与文本回答解析一起失配。

## 变更内容

- 让问卷展示协议对齐 `codument/std/protocols.md` 中的 `ask-multi-question-free`
- 为多题问卷提供稳定的 `Q1` / `Q2` / `Q3` 题号，以及 `A` / `B` / `C`... 选项编号
- 在有候选选项的问题中，始终保留最后一个自由填写选项，并给予顺序字母编号
- 让文本回答协议接受类似 `q1: a ; q2: b`、`q3: D balabala` 的输入形式
- 保留完整 `questions[]` 结构穿过 semantic、history、runtime client 与 TUI，而不是压扁成首题
- 为推荐类场景引入结构化 intake 策略，至少覆盖旅行推荐这一类高频案例

## 影响范围

- 受影响的规范：
  - `aiagent-questionnaire`
  - `terminal-tui-shell`
- 受影响的代码：
  - `Questionnaire` 工具合同与提示
  - semantic questionnaire projection
  - message history questionnaire projection
  - questionnaire text parser
  - prototype / textual TUI 问卷展示

## 顺序依赖关系

- 建议序号：`4`
- 建议前置：
  - `add-tui-input-and-material-state-foundations`
  - `enhance-tui-approval-and-delegation-history`
- 说明：
  - 本 track 依赖当前 TUI 已具备可操作的问卷 surface
  - 但它独立解决“协议、模板、解析、投影压扁”问题，不应继续塞进 approval/history track
