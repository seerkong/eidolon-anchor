# 设计：legacy tool alias 收口

## 当前问题

虽然默认工具注册表已经不暴露 `Collective* / Formation*`，但这批旧工具目录内仍保留了独立逻辑：

- create/add/appoint 直接走旧 manager helper
- status/assign 仍以旧组织前缀和旧组织类型作为主叙述

这意味着 legacy alias 仍然是“可运行的第二套实现”，而不是“显式兼容边界”。

## 方案

将本次收口限制在 internal-only 旧工具族：

1. 在 `tools/` 下增加 shared legacy alias helper
2. 让 `Collective*` 基于 `holon.governance = autonomous` 做解析与回写
3. 让 `Formation*` 基于 `holon.governance = leader_led` 做解析与回写
4. 保留旧工具的 schema、prompt 资产、注册名和 legacy 输出字段
5. 将 focused tests 扩展到 status/assign，避免只覆盖 create/add/appoint

## 关键决策

| 决策 | 理由 |
|------|------|
| 旧工具名保留，但逻辑必须 alias 到 holon-first 路径 | 保持 internal-only 兼容边界，同时消除平行实现 |
| 继续保留 `collective_id` / `formation_id` 输出字段 | 避免 internal-only 调用方被一次性打断 |
| 本轮不处理 lane/workload/event payload 旧名 | 这些属于更深层协议边界，和工具 alias 收口不是同一个改动单元 |

## 风险

- 如果 legacy 输出字段映射不完整，internal-only 使用方可能出现回归
- 如果 alias 只覆盖 create/add/appoint，没有覆盖 status/assign，仍会留下行为分叉

## 验证

- focused tests:
  - `organization_tools.test.ts`
- strict validation:
  - `codument validate refactor-aiagent-holon-legacy-tool-aliases --strict`
