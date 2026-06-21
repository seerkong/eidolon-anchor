# Design: enhance-tui-approval-and-delegation-history

## 目标

让新的 prototype-first TUI 同时具备以下三类能力，并且三者之间边界清晰、可协同演进：

- 活动中的 permission / questionnaire 请求可以直接在 approval pane 中完成交互式处理
- 已完成的 approval / questionnaire 决策可以在历史区被回看，而不是处理完就消失
- delegation、question、task tree 等编排型工具调用可以在消息区中以结构化卡片展示，而不是只剩摘要文本

本 track 的重点不是“重新发明 approval flow”，而是把已经存在但分散的 approval 交互骨架、历史回显缺口和 delegation/question 卡片接入统一起来。

## 当前现状

### 1. approval pane 已存在基础交互能力，但目标边界还没冻结成独立 track

当前代码已经有 `prototype/features/approval/approval-pane.tsx`，并且具备：

- permission 请求的直接回复：
  - `enter` / `a` -> allow once
  - `w` -> allow always
  - `esc` / `r` -> reject
- questionnaire 请求的直接回复：
  - 上下移动选项
  - 左右切换问题
  - 多选题 `space` toggle
  - 支持 `Type your own answer`
  - `enter` 提交当前选择或继续下一题
  - `esc` / `q` reject

这说明“交互式作答”本身不是空白能力，而是已经有一套 prototype 骨架。

### 2. 已有实现主要解决“当前阻塞能处理”，还没有把历史与卡片语义收完整

从 `refactor-terminal-tui-shell` 的 gap reports 可以看出，之前已经完成了：

- graph 跟踪 pending permission / question 队列
- composer 在 approval/question 未处理时阻塞提交
- approval pane 将回复路由回 runtime client
- richer permission details、custom answer、未答题组保持空数组等 parity 修正

但这些工作仍然主要集中在“活动请求能处理”。本 track 要继续补的是：

- approval / questionnaire 完成后的历史摘要投影
- question answers 与 delegation 历史的统一展示语言
- delegation / task tree / question tool parts 进入新消息主链

### 3. question / task tree 卡片素材已经存在，但尚未在当前 merged track 中固定接入策略

仓库测试已经断言 `tasktreewrite` / `tasktreeread` 在 registry 中存在且不是 `GenericTool`。这说明相关素材不是从零开始做，而是要：

- 明确它们如何进入当前消息主链
- 明确 question card 与 approval pane 的职责分工
- 明确 delegation 历史与 approval history 的关系

### 4. 本 track 必须避免的两类边界混乱

如果边界不清，会很容易出现以下问题：

- approval pane 和消息历史都在展示同一个活动请求，造成重复与冲突
- question 既被当作“当前要回答的 questionnaire”，又被当作“普通工具卡片”同时出现，用户不清楚在哪里操作

因此本 track 的第一优先级是冻结边界，而不是直接堆更多卡片。

## 设计原则

### 1. 活动请求与历史结果分层

- approval pane：只负责当前活动中的 permission / questionnaire 请求及其直接交互
- 历史区：只负责已完成请求的摘要与回看
- 两者不得同时把同一活动 request 作为“当前可操作对象”

### 2. 交互式回复优先保持 prototype 已有骨架

本 track 不重写 approval pane 的交互模型，优先沿用已有 prototype 行为：

- permission：allow once / allow always / reject
- question：单选、多选、多题切换、自定义答案、reject

若发现现有行为与 legacy parity 仍有缺口，应在此 track 中显式修补，但不另起一套新的问答 UI 语言。

### 3. question 的“阻塞交互”和“历史/工具卡片”职责分离

- 活动中的 questionnaire request：由 approval pane 承接并提供交互
- 已完成的 question answers：进入历史摘要或 question card
- 非活动中的 tool-part question / task tree / delegation：由消息区 dedicated cards 承接

也就是说，“question”不是单一 surface，而是按生命周期拆成：

- pending interactive
- completed historical
- tool/result visualization

### 4. 历史摘要要和 delegation 语义统一

approval summary、question answers、delegation progress 三者都属于“用户需要回看的结构化决策/编排结果”。

因此它们在语言和信息层次上应统一考虑：

- 标题要能看出事件类型
- 摘要要优先展示结果，而不是重复原始请求
- 详细内容要足够回溯，但不能压过主消息流

## 目标方案

### 1. 冻结 approval pane 与 history 的展示边界

需要先明确以下规则：

- pending permission / question 只在 approval pane 中交互
- 请求处理完成后，从 active queue 消失，并转入历史摘要
- 历史区展示“当时如何决定/如何回答”，而不是继续渲染为待处理表单

### 2. 冻结 approval/question 交互式回复合同

把当前 prototype 已存在的交互行为明确写入 track 范围：

- permission：
  - once / always / reject 三类回复
  - 展示 richer runtime context，例如 command、filepath、pattern、tool scope
- questionnaire：
  - 支持单选 / 多选 / 多题切换
  - 支持 custom answer
  - reject 不应误提交默认值
  - 未作答的问题组保持空数组

这样新 session 执行时不会把“交互式回复是否也在本 track 范围内”再讨论一轮。

### 3. 定义 approval history 的最小信息模型

建议历史摘要至少包含：

- 事件类型：permission / questionnaire
- 决策结果：allow once / allow always / reject / answers submitted
- 关键信息摘要：
  - permission: permission type + summary + key details
  - questionnaire: question header / selected answers / custom answers

必要时在详情中保留更丰富上下文，但默认摘要应以“结果”为中心。

### 4. 定义 delegation / question / task tree cards 的接入边界

消息区 dedicated cards 应覆盖：

- `task`
- `question`
- `tasktreewrite`
- `tasktreeread`

并明确：

- 当前活动中的 questionnaire request 不走普通 question card 交互
- 已完成后的 question result / task tree content 可以作为历史/卡片的一部分出现
- delegation 历史需要和 session navigation / approval history 的时间顺序保持一致

### 5. 测试与验收优先锁定行为，而不是视觉细节

本 track 的高风险点主要在语义和交互，而不是视觉样式：

- queue 先后顺序
- 当前 active item 与历史摘要切换
- question answer resolution
- dedicated card 命中与 fallback 不冲突

因此测试重点应放在这些行为约束上。

## 实施分解

### Phase 1: Freeze Contract

- 冻结 approval pane、history、question/delegation cards 的职责边界
- 冻结 permission/question 的交互式回复合同
- 冻结 question 生命周期在 pending / completed / card 三个阶段中的展示规则

### Phase 2: Approval Interaction And History

- 补齐 permission/question 交互式回复的 parity 缺口
- 建立 approval / questionnaire 历史摘要投影
- 保证 active queue 与 history 切换不冲突

### Phase 3: Delegation And Question Card Integration

- 把 task / question / task tree cards 接入新的消息主链
- 为 delegation 历史和问卷结果建立统一展示语义
- 对齐与 session navigation / history 的交互顺序

### Phase 4: Verification

- 补 focused tests 覆盖 approval interaction、history projection、delegation/question cards
- 运行 terminal TUI 测试
- 手工点验 permission / question 的完整交互闭环与历史回看

## 测试策略

自动化测试至少覆盖：

1. permission 回复路径包含 once / always / reject
2. questionnaire 支持多选、多题、自定义答案，未答题组保持空数组
3. active approval item 处理完成后进入历史摘要，而不是直接消失
4. delegation / question / task tree 工具命中 dedicated cards
5. approval pane、消息历史和 composer blocked 状态保持一致

手工验收至少覆盖：

- permission 请求回复与 richer details
- questionnaire 多题切换、自定义答案、reject
- 完成后在历史区回看结果
- delegation / question / task tree cards 的可读性

## 风险与取舍

### 风险 1: 活动请求与历史摘要重复显示

应对：

- 在 plan 中明确“active 只在 pane，completed 才入 history”
- 用测试固定切换时机

### 风险 2: question 既作为表单又作为工具卡片，职责冲突

应对：

- 先冻结 pending/completed/card 三态规则
- 验证中专门检查同一事件不会同时以两个交互入口出现

### 风险 3: 只补展示，不补交互，导致 track 目标继续含糊

应对：

- 已在本 track 中显式纳入 permission/question 的交互式回复能力
- `spec.md`、`plan.xml` 和 `acceptance.md` 都要把这部分写成明确交付项

## 交付结果

本 track 完成后，新的 prototype TUI 应具备以下能力：

- 当前活动中的 permission / questionnaire 请求可直接在 approval pane 中完成交互式处理
- 已完成的 approval / questionnaire 结果可以在历史区回看
- delegation、question、task tree 类型工具调用在消息区中以结构化卡片呈现
- approval pane、历史区、消息区与 composer blocked 语义彼此一致
