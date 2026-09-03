# eidolon-anchor 子代理 sessionId 管理规范

> 编写背景：2026-08 月 depa-session-insights v0.x 开发中发现 Claude subagent 会话因每行 `sessionId` 都指向主会话 UUID 而被去重误杀（315 个 subagent 被跳过）；修复方案是合成唯一键 `主会话UUID@subagent:<agentId>`。该问题在 eidolon-anchor 的 AIA 子代理中同样面临，本文给出规范。

## 1. 子代理标识命名

每个 AIA 子代理（AIAgentTask/ExternalJob/Timer/TaskStep）在创建时必须有一个**独立唯一标识**，格式如下：

```
<父fiberId>:<子代理类型>:<实例id>
```

例如：

| 场景 | 标识示例 |
|---|---|
| AIAgentTask 执行 codument verify | `019ff2a1-...:AIAgentTask:codument-verify-track` |
| ExternalJob 跑 dsi distil | `019ff2a1-...:ExternalJob:dsi-distil-2026-08` |
| Timer 健康检查 | `019ff2a1-...:Timer:health-check-300s` |

此标识需要出现在：
- 子代理的**事件日志**（event payload 的 `agentId` 字段）
- 子代理**上下文压缩记录**（compaction event 的 `agentId`）
- 子代理结束时**归档到父 fiber 摘要**中（见 §3）

## 2. 上下文隔离原则

**子代理的完整工具输出、reasoning、消息历史不应回注主会话**，以避免父 fiber 的上下文窗口被子代理大段输出撑爆。

行为定义：

| 内容 | 回注到父 fiber？ | 存储位置 |
|---|---|---|
| 子代理**完整消息历史 + 工具调用** | **否** — 独立存储 | `子代理实例 id` 为键的独立上下文存储 |
| 子代理**最终摘要**（≤4KB） | **是** — 注入父 fiber | 父 fiber 的 `subagent_summary` 事件 |
| 子代理**compaction 日志** | 标记但不存储文本 | compaction event 带 `agentId` 标记 |
| 子代理**错误/abort** | **是** — 摘要形式注入 | 截断至 ≤2KB 的 `subagent_error` 事件 |

**设计目标**：复盘时可通过**子代理独立 id 检索完整上下文**（如 `dsi query "019ff2a1-...:AIAgentTask:codument"`），但不让日常会话被它撑满 token。

## 3. 子代理结束时的归档行为

子代理结束时（正常完成 / 错误 / abort），生成一个 `subagent_completed` 事件，包含：

```json
{
  "type": "subagent_completed",
  "agentId": "019ff2a1-...:AIAgentTask:codument-verify-track",
  "status": "pass | fail | abort",
  "summary": "≤4KB 的文本摘要",
  "invariant_check": "是否通过 AttractorCheck",
  "output_files": ["文件列表"],
  "errors": ["错误详情（如有）"]
}
```

## 4. 与 depa-session-insights 的兼容性

- 子代理的独立标识应能被 `dsi query` 检索：匹配 `:AIAgentTask:` / `:ExternalJob:` 等子代理类型前缀
- 蒸馏报告（`dsi distil`）中，子代理任务应作为独立蒸馏条目出现（而非淹没在父会话里）
- 父会话的蒸馏条目中写"含子代理"，并给出子代理标识以便跳转

## 5. 迁移路径

- **v0.x**（现状）：子代理上下文可能混入父 fiber，无独立标识
- **v0.y**（本规范后）：新增子代理独立标识（不改变父 fiber 结构），已有子代理类型可逐步加上 `agentId`
- **v1.0**（目标）：子代理上下文隔离落地，完整事件独立存储