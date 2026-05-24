# 设计：shell bridge and AI slash decoupling

## 1. 目标

Wave 8 处理两个强关联问题：

- shell bridge 仍知道太多 AI runtime internals
- AI slash contract 仍硬编码在 `terminal/core`

## 2. 实施方向

- 把 slash grammar/help/prompt expansion 的正式 truth 下沉到 AI domain kernel
- `terminal/core` 只保留 generic parser/renderer helper，或完全改为 descriptor consumer
- `TerminalRuntime` 继续退化为 capability-port consumer

## 3. 风险

- slash surface 是高频用户入口，回归风险高
- 必须依赖 focused tests，而不是源码 grep
