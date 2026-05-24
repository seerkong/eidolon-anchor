# Design: add-tui-questionnaire-history-center

## 目标

把 questionnaire 的“历史查看能力”从主消息历史中剥离出来，改为：

- 状态栏聚合入口
- questionnaire history 列表弹窗
- questionnaire detail 详情弹窗

这样用户既能回看旧 questionnaire，又不会让长问卷持续占住主对话视口。

## 当前问题

### 1. 长问卷会占据主消息历史底部

questionnaire 完成后仍停留在主消息历史区域。若问卷题目很多，用户会被旧 questionnaire 卡住视线，误判为“系统没有继续处理”。

### 2. 历史 questionnaire 的查看方式与当前对话竞争

现在历史 questionnaire 的回看依赖主消息流本身。它把“回看历史 intake”与“继续当前对话”混在一起，导致视图层次不清。

### 3. 缺少统一的 questionnaire 汇总入口

用户无法一眼知道：

- 当前会话里总共有多少 questionnaire
- 哪些已完成
- 哪些仍待处理

## 设计原则

### 1. 主消息历史保持稳定

消息历史只承担消息流本身，不再承担历史 questionnaire 的完整浏览职责。

### 2. questionnaire 历史通过 modal 分层查看

questionnaire 历史列表与详情都放入 modal，减少对主视口的争夺。

### 3. pending questionnaire 比 done questionnaire 更优先

状态栏和历史列表都要首先让用户知道还有没有未处理 questionnaire。

### 4. 历史列表摘要化，详情再下钻

默认显示摘要，避免列表本身再次演变成长问卷墙。

## 方案概览

### 1. Footer questionnaire status entry

在底部状态栏增加一个按钮，建议内容类似：

- `问卷 3 已完成 / 1 待处理`

若空间紧张，也可以降级为紧凑版，但必须仍能区分 done 与 pending。

### 2. Questionnaire history modal

点击状态栏按钮后打开列表 modal。列表项包含：

- 标题
- 状态
- 时间
- answered/total
- 一行摘要答案

排序规则：

- pending 在前
- 同状态内按时间倒序

### 3. Questionnaire detail modal

在 history modal 中继续查看详情时，打开第二层 detail modal。详情展示：

- 标题与状态
- 完整题目
- 选项
- 用户回答
- 解析后的结构化结果

关闭 detail 后回到 history modal，而不是回到主消息视图。

### 4. Continue-session rehydration

questionnaire history center 不能只依赖“本次 TUI 运行期间收到的问卷事件”。当用户继续一个已有会话时，footer 计数、history 列表和 detail 数据都需要从已存在的 runtime questionnaire tool record 中重建。

重建策略：

- 从 runtime message/tool part 中识别 questionnaire tool 调用
- 用 tool input 重建 questionnaire request/title/questions
- 用 tool output 恢复已完成 questionnaire 的 answered/summary/structured answers
- 对仍为 pending 的 questionnaire 保留待处理状态，并继续在 history 列表中置顶

## 影响范围与修改点

预计影响：

- questionnaire 历史聚合状态
- footer/status bar UI
- modal 管理
- questionnaire 历史摘要与详情数据组装

潜在代码落点：

- `terminal/packages/tui/src/cli/cmd/tui/prototype/graph.ts`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/index.tsx`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/features/...`

## 关键决策

### 决策 1：不修改主消息历史内容结构来承载完整 questionnaire 查看

理由：

- 避免长 questionnaire 挤压主视口
- 避免历史回看与当前对话争夺同一块空间

### 决策 2：采用列表 modal + 详情 modal 两级结构

理由：

- 列表保持高密度摘要
- 详情保持完整信息，不把列表做成二次“问卷长墙”

### 决策 3：状态栏入口必须同时体现 done 与 pending

理由：

- 单纯的总数如 `3/4` 有歧义
- 用户真正关心的是“还剩几个待处理”

## 风险与权衡

### 风险 1：footer 空间不足

缓解：

- 允许设计紧凑文案
- 但必须保留 done/pending 的区分语义

### 风险 2：modal 层级过深导致键盘交互复杂

缓解：

- 明确 `enter` 查看详情、`esc` 返回上一层/关闭
- 保持层级最多两层

### 风险 3：questionnaire 历史数据可能散落在多处状态

缓解：

- 在 graph/projection 层集中维护 questionnaire history 聚合视图
- footer 与 modal 都只读同一份聚合状态

### 风险 4：继续已有 session 时 history center 丢失历史 questionnaire

缓解：

- 在 runtime hydrate 路径补齐 questionnaire record 重建
- 用 focused test 覆盖 completed + pending questionnaire 的恢复场景

## 测试策略

自动化测试至少覆盖：

1. footer questionnaire 计数正确显示 done/pending
2. 打开 history modal 不影响主消息历史
3. history modal 正确排序 pending 与 done
4. 从 history modal 打开 detail modal 能看到完整 questionnaire 详情
5. 关闭 detail 后返回 history，关闭 history 后返回主视图
6. 继续已有 session 时，questionnaire center 能从 runtime history/tool record 恢复 done/pending 与详情数据

手工点验至少覆盖：

- 长 questionnaire 完成后，主视图仍能优先看到新 assistant 输出
- 通过 footer 入口进入列表和详情查看旧 questionnaire
- pending questionnaire 在列表中有明显优先级
