# Design: AIAgent thread goal runtime

## 上下文

本项目已经具备：

- namespace/action 风格的 slash command 解析
- 统一工具注册与 prompt 组装
- 会话持久化与 runtime support
- tool / event / session 编排基础

但目前缺少一条与 Codex 相近的 goal 主链：

1. 用户显式设置长期目标
2. 模型可以读取并在严格边界内更新目标
3. runtime 自动记录 token / time usage
4. active goal 在空闲时可继续推进
5. complete / blocked 必须经过证据审计

## 方案概览

### 1. Goal 数据层

引入 thread-scoped goal store，保存：

- `goalId`
- `objective`
- `status`
- `tokenBudget`
- `tokensUsed`
- `timeUsedSeconds`
- `createdAtMs`
- `updatedAtMs`

状态集对齐 Codex：

- `active`
- `paused`
- `blocked`
- `usage_limited`
- `budget_limited`
- `complete`

### 2. 用户入口层

新增 `/goal` 入口，支持：

- `/goal <objective>`
- `/goal`
- `/goal edit`
- `/goal pause`
- `/goal resume`
- `/goal clear`

其中 `/goal <objective>` 是主要写入入口；当已有未完成目标时，需要确认替换。

### 3. 模型工具层

新增三类工具：

- `get_goal`
- `create_goal`
- `update_goal`

约束：

- `create_goal` 只能在用户或系统明确要求时使用
- `update_goal` 只能写 `complete` 或 `blocked`
- pause / resume / budget limit / usage limit 由用户或系统控制

### 4. Runtime 生命周期层

在 turn started / tool completed / turn finished / abort / resume / external mutation 等节点上执行 goal accounting。

当 goal 为 `active` 且系统空闲时：

1. 读取当前 goal
2. 生成 hidden continuation prompt
3. 注入到当前 session input queue
4. 启动下一轮 turn

### 5. Prompt 与审计层

为 goal continuation、budget limit、objective update 准备模板，确保模型在结束前进行 requirement-by-requirement 审计。

### 6. 状态传播层

goal 状态变更要能被用户可见 surface 感知，至少包括：

- 当前目标
- 当前状态
- token / time usage
- pause / resume / clear 结果

## 影响范围

- slash parser / command descriptors
- tool registry / tool contracts
- session runtime hooks
- persistence / state db
- UI / status view
- tests / fixtures / prompt assets

## 风险 / 权衡

- 自动续跑若没有严格 idle 判定，可能抢占用户输入。
  - 缓解：必须检查 active turn、待处理输入和 mode gate。
- fuzzy 或宽松审计会导致目标被过早标记完成。
  - 缓解：complete 仅允许在证据足够时；blocked 需连续重复阻塞条件。
- 持久化目标若没有 session-scoped 约束，可能污染 ephemeral session。
  - 缓解：对 ephemeral thread 禁止 goal 写入或显式报错。

## 兼容性设计

- 保持现有工具注册模型不变，只增加 goal 相关工具。
- slash 解析优先兼容当前 namespace/action 风格，再补齐 `/goal` 直接 objective 入口。
- goal 相关状态变化通过事件或状态查询向外传播，不破坏现有 session 流程。

## 迁移计划

1. 先补 goal 数据模型、存储与测试。
2. 再补 `/goal` 入口和 goal tools。
3. 再补 accounting、budget、idle continuation。
4. 再补 prompt contract、状态传播和 UI 同步。
5. 最后做 targeted verify 与 gap-loop 收口。

