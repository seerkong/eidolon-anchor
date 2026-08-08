# 变更：执行 Eidolon Workflow 最终产品验收

## 背景和动机 (Context And Why)

建立已经分别完成 authoring lifecycle、run/fact/Material lifecycle、架构边界 seam 和人类产品体验。最终仍需一个独立、可执行的总验收，把这些局部证据连接成完整 requirement-to-evidence coverage，并从构建、安装、对话、CLI 和恢复入口验证同一产品。

## “要做”和“不做” (Goals / Non-Goals)

目标：

- 建立并关闭完整建立矩阵，每项都有 required behavior、目标证据、架构约束和测试。
- 复用原始业务场景验证自然语言 authoring、执行、等待、Material 和恢复。
- 验证编译与临时安装后的 TUI/CLI 产物包含同一个 native workflow 能力。
- 运行真实 headless actor、两类 runtime 和 fresh-runtime recovery smoke。
- 用独立验证给出最终 PASS/GAP/BLOCKED 裁决。

非目标：

- 不新增另一套 workflow 功能或改变已通过的产品协议。
- 不使用 MCP、外部 agent CLI 或 XML authoring 作为验收捷径。
- 不用 prompt 关键词存在代替工具调用、事实落盘和恢复证据。

## 变更内容（What Changes）

- 增加最终 acceptance matrix fixture 和 executable acceptance suite。
- 增加编译/临时安装/真实 actor/恢复验收记录。
- 若发现 gap，在本 track 范围内修复并复跑；结构性偏差返回 mission 重规划。

## 影响范围（Impact）

- 受影响能力：`eidolon-ai-workflow-native-capability`
- 主要产物：workflow acceptance tests、最终 matrix、Codument verification evidence。
