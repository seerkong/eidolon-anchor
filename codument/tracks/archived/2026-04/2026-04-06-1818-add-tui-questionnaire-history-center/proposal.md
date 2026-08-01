# 变更：添加 TUI 问卷历史中心

## 背景

当前 questionnaire 在 TUI 中完成后仍然依附在主消息历史中，长问卷会持续占据底部视口，使用户难以看到问卷后的新 assistant 输出。用户希望保留历史 questionnaire 的可回看能力，但不希望通过修改或展开消息历史来实现。

## 变更内容

- 在底部状态栏增加 questionnaire 聚合入口，显示已完成与待处理问卷数量
- 点击状态栏入口后，打开问卷历史列表弹窗，而不是改写主消息历史
- 在列表中支持继续查看单个 questionnaire 的详情弹窗
- 在详情弹窗中展示完整题目、选项、用户回答与结构化结果
- 保持主消息历史稳定，不通过展开历史卡片来查看旧问卷

## 要做

- 定义状态栏按钮文案、计数规则与高亮规则
- 定义 questionnaire 历史列表弹窗的摘要字段、排序和交互
- 定义 questionnaire 详情弹窗的内容结构和返回路径
- 明确主消息历史与弹窗之间的边界
- 规划最小可验证的实现与测试

## 不做

- 不把旧 questionnaire 重新展开到消息历史中
- 不在本 track 中重做 questionnaire 协议本身
- 不在本 track 中引入新的 recommendation/questionnaire 生成策略

## 影响范围

- 受影响的规范：
  - TUI 问卷历史与状态入口
- 受影响的代码：
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/`
  - 相关状态聚合、状态栏、modal、questionnaire history 数据投影
