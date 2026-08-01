# 设计：shell runtime facade phase2

## 1. 目标

继续让 shell bridge 从“知道较多 AI glue 的桥”收紧为“消费更窄 domain facade port 的桥”。

## 2. 实施方向

- 识别 `TerminalRuntime` 中仍直接 import 的 AI runtime internals
- 在 `domain-ai-logic` 或等价正式宿主上提供更窄 facade
- 让 terminal/tui/headless 优先消费这些 facade，而不是自己拼 orchestration 细节

## 3. 风险控制

- 不做 runtime 主路径重写
- 不让 shell 为了 facade cutover 临时复制一套默认行为
