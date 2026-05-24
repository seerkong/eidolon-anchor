# 变更：推进 shell runtime facade phase2

## 背景和动机

Wave 8 已让 shell 消费 slash capability port，但 `TerminalRuntime` 仍直接知道较多 AI runtime internals。

如果不继续做 facade 收紧，shell bridge 虽然不再持有行为真相，仍会长期承担过厚的 AI orchestration glue。

## 要做

- 为 shell/runtime entry 定义更窄的 domain runtime facade port
- 让 `TerminalRuntime`、headless 与相关 facade 更少直接知道 orchestrator/coordinator/organization internals
- 建立 focused tests 锁定 shell 只能消费 capability port

## 不做

- 本次不彻底消除所有 AI bridge glue
- 本次不重写 runtime 主执行路径

## 影响范围

- `terminal/packages/organ`
- `terminal/packages/organ-support`
- `terminal/packages/tui`
- `cell/packages/domain-ai-logic`
- focused tests
