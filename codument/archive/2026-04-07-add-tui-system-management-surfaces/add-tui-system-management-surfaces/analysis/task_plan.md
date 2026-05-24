# Task Plan: add-tui-system-management-surfaces

## Goal

让 prototype TUI 中现有的 session、provider/model、agent、MCP materials 收敛成可一致触发、可联动当前状态、可验证的 system management surfaces。

## Current Phase

Phase 1

## Phases

### Phase 1: Requirements & Discovery
- [x] 确认现有 system materials 与 command palette 基础
- [x] 确认前置依赖已由 `add-tui-input-and-material-state-foundations` 提供
- [x] 将关键发现写入 `findings.md`
- **Status:** completed

### Phase 2: Planning & Structure
- [x] 补齐 metadata / design / plan
- [x] 把现状、缺口和闭环写成可执行任务
- **Status:** completed

### Phase 3: Implementation
- [ ] 收敛 session surface 与 route/current session state
- [ ] 收敛 provider/model/agent surface 与 current selection
- [ ] 收敛 MCP management surface 与 sync refresh
- **Status:** pending

### Phase 4: Testing & Verification
- [ ] 补 focused tests
- [ ] 跑 terminal TUI 相关测试
- [ ] 手工点验 system surfaces
- **Status:** pending

### Phase 5: Delivery
- [ ] 根据实现更新状态
- [ ] 准备 gap-loop / archive
- **Status:** pending
