# Design: add-tui-system-management-surfaces

## 目标

把 prototype TUI 中已经存在但仍然分散的 system materials 收敛成一组可持续维护的 system management surfaces，使用户能够稳定地：

- 浏览和切换 session
- 浏览 provider 并切换 model
- 切换 agent
- 查看和切换 MCP 状态

同时这些 surfaces 要与已经 graph 化的当前选择态和 runtime 同步状态保持一致，而不是继续依赖零散的局部状态或“仅命令面板可见”的弱入口。

## 当前现状

### 1. system materials 基本已经存在

当前仓库里已经有以下 dialog / material：

- `session-list-dialog.tsx`
- `session-rename-dialog.tsx`
- `provider-dialog.tsx`
- `model-dialog.tsx`
- `agent-dialog.tsx`
- `mcp-dialog.tsx`
- `status-dialog.tsx`
- `theme-dialog.tsx`

这些材料说明本 track 不是“从零实现 system surface”，而是“把已有材料组织成真正可交付的系统管理层”。

### 2. command palette 已经能打开其中一部分能力

`prototype/command-palette.tsx` 已经注册了：

- Sessions
- Connect Provider
- Models
- Agents
- MCP Servers
- Status
- Appearance

这意味着“可触发入口”已经有初版，但仍有两个问题：

- 入口主要仍停留在 command palette，缺少更明确的 system management 收敛边界
- track 文档尚未明确哪些算本 track 已有基础，哪些算剩余要补齐的闭环

### 3. 当前选择态已经进入 graph，但 adapter 与 surface 的联动边界还需冻结

在前置 track `add-tui-input-and-material-state-foundations` 完成后：

- route / selection / composer draft 已进入 prototype graph
- `route-context` / `local-context` 已作为 graph adapter 存在

因此本 track 不应再重新设计 selection state，而应明确：

- session switch 通过 route / session graph 状态收敛
- provider/model/agent 切换通过 selection graph 状态收敛
- MCP 与 sync 状态联动，但不把其所有本地过程粗暴塞进 graph

### 4. 最大缺口不在“有没有 dialog”，而在“一致性与验收闭环”

从当前代码结构看，真正缺的是：

- system surfaces 与 graph-backed current state 的职责边界文档
- 对 session / provider-model / agent / MCP 四条链路的最小闭环验收
- focused tests，证明这些 surfaces 不是“能打开”，而是“能稳定联动当前状态”

## 设计原则

### 1. 复用已有 materials，不重复造第二套 system UI

本 track 应优先基于当前已存在的 dialogs 推进，而不是重新发明新的系统管理框架。

### 2. 统一 current state 真相

所有“当前选中态”都应以 graph / adapter 收敛后的当前态为真相：

- session：route/session state
- provider/model/agent：selection state
- MCP：sync data + local action adapter

### 3. command palette 是入口之一，但不是唯一的系统边界说明

就算继续以 command palette 作为主要入口，也必须把：

- 哪些 surface 属于 system management
- 它们如何读取和写回当前状态
- 它们的键盘交互和刷新行为

写成明确合同，否则后续 command palette / status / help 会继续各自演化。

### 4. 最小闭环优先

本 track 的闭环应当是：

- 打开 surface
- 看到当前状态
- 执行切换/管理动作
- 状态回写到 graph / sync
- 其他 surface 与主界面读到一致结果

而不是继续扩展更大的管理后台能力。

## 目标方案

### 1. Session surface

- 以 `DialogSessionList` 为主实现
- 支持浏览、切换、rename、delete
- 切换后 route/session state 与主界面 history 链保持一致

### 2. Provider / model surface

- `DialogProvider` 负责连接流程
- `DialogModel` 负责切换 model
- 切换后 selection state 统一回写到 graph-backed current state
- favorites / recent 保持 adapter 职责，不改成 graph 真相

### 3. Agent surface

- `DialogAgent` 提供 agent 切换
- 切换后 graph current selection 与 provider/model 默认回填保持一致

### 4. MCP surface

- `DialogMcp` 展示当前 MCP 状态
- toggle / reconnect 等动作通过 runtime client 执行
- refresh 后同步刷新 `sync.data.mcp`

### 5. Verification

focused tests 至少覆盖：

- command palette / system surface 入口是否仍可用
- session 切换是否更新当前 route
- model / agent 切换是否更新 current selection
- MCP toggle 后是否刷新状态

## Phase 分解

### Phase 1: Contract Freeze

- 冻结 system surface 的职责边界
- 明确 graph / adapter / sync 各自职责

### Phase 2: Session And Selection Surfaces

- 收敛 session list / route
- 收敛 provider-model / agent 与 current selection

### Phase 3: MCP And System Surface Consistency

- 完成 MCP 管理交互闭环
- 对齐 command palette / status / surface 的一致性

### Phase 4: Verification

- focused tests
- terminal TUI 测试
- 手工点验 system surfaces

## 风险与取舍

### 风险 1：看起来“已经有入口”，实际状态写回不一致

缓解：

- 明确 current state 读取与写回链路
- 用 focused tests 锁住 route / selection / mcp refresh

### 风险 2：继续让 system materials 停留在“散装 dialog”

缓解：

- 把它们统一纳入本 track 的 contract / plan / acceptance
- 不再把这类 surface 当作零散临时功能

### 风险 3：把 status/help/theme 一并过度膨胀进来

缓解：

- 本 track 聚焦 session / provider-model / agent / MCP 四条主链
- status/theme 只作为联动一致性的辅助上下文，不额外交付大范围 polish
