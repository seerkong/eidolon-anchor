# 协议状态与控制动作说明

协议状态、shutdown、plan review 等控制动作不属于独立一级命令。

协议化协作仍然存在，但公开命令面已经并入新的 actor-first 模型。

## 当前原则

- 对对象查询状态：优先使用 `/actor status <target>`
- 对对象持续监听：使用 `/actor watch <target>` / `/actor unwatch <target>`
- 对成员或组织发起任务：使用 `/member assign`、`/collective assign`、`/formation assign`
- shutdown / plan review / protocol status 等控制动作：通过正式工具能力承载

## 当前用法

| 需求 | 当前做法 |
|------|----------|
| 查看协议请求状态 | 使用正式协议状态工具；对象级状态查看改用 `/actor status <target>` |
| 对成员发起 shutdown | 使用正式 shutdown 工具能力 |
| 查看 shutdown 状态 | 使用正式 shutdown 状态工具能力 |
| 处理 plan review | 使用正式 plan review 工具能力 |

## 设计原因

- 协议状态不是对象模型中的一级对象
- 正式命令面要统一到 actor / member / collective / formation
- 控制类动作保留为正式工具能力，而不是额外命名空间
