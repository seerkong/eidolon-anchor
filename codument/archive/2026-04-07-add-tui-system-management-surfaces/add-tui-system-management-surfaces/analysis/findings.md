# Findings & Decisions

## Requirements

- track 目标不是从零实现 system dialogs，而是把已有 materials 收敛成可交付的 system management surfaces
- 主要 scope 是 session、provider/model、agent、MCP
- 依赖 `add-tui-input-and-material-state-foundations` 已完成的 graph-backed current state

## Research Findings

- `prototype/command-palette.tsx` 已经能打开 Sessions、Connect Provider、Models、Agents、MCP、Status、Appearance
- `prototype/materials/system/` 下已有 session/provider/model/agent/mcp/status/theme dialogs
- `route-context` 与 `local-context` 已经建立在新的 prototype state/graph adapter 之上
- 最大缺口是 track 文档、联动边界和 focused verification，而不是材料是否存在

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| 以现有 dialogs 为主线规划本 track | 避免重复造 system UI |
| session / selection 走 graph-backed current state | 与前置 foundations 保持一致 |
| MCP 继续用 sync data + local action adapter | 不把运行时管理细节强行 graph 化 |
| status/theme 作为上下文，不作为本 track 主交付 | 控制范围，避免 system track 失焦 |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| 当前 track 缺失 metadata/plan/design | 在本轮补齐为可执行形态 |
| 代码已部分存在，容易把 plan 写成“假新功能” | 在 design 与 plan 中显式记录“已有基础 + 剩余闭环” |
