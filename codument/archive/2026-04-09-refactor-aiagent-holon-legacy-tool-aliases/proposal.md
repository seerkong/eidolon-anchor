# 变更：将 legacy `Collective* / Formation*` 工具族收口为 holon-first alias

## 背景

正式对象模型和默认工具面已经切到 `member / holon / primary`，但 internal-only 的 `Collective* / Formation*` 旧工具族仍保留独立实现逻辑。

这会带来两个问题：

- 旧工具名虽然已经退到兼容边界，但仍可能继续漂移出与 holon-first 主路径不同的行为
- 后续如果继续删除旧名，会先被这批重复逻辑拖住

## 变更内容

- 将 `Collective* / Formation*` 旧工具族改为显式 legacy alias
- 让旧工具族通过 holon-first 路径完成 create/add/appoint/status/assign，而不是继续维护独立主逻辑
- 保留旧工具名、旧输入字段与旧输出字段，确保 internal-only 兼容边界仍可用

## 非目标

- 不删除 `Collective* / Formation*` 旧工具目录与 prompt 资产
- 不处理 lane/workload、event payload、task-tree `activeForm` 等更深的协议旧名
- 不在本 track 中继续清理 `OrganizationManager`、executor、runtime event 的全部旧语义名

## 影响范围

- 受影响代码：
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/Collective*`
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/Formation*`
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/_holonTooling.ts`
  - `cell/packages/organ-logic/tests/AIAgent/organization_tools.test.ts`
- 受影响规范：
  - 当前 formal `holon` 规范不变
  - 本次只收口 internal-only legacy alias 行为
