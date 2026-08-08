# 变更：要求真实公网多来源 TUI Workflow E2E

## 背景和动机 (Context And Why)

既有真实 TUI journey 使用单一本地 HTTP fixture，只证明网络和产品链路连通，不能代表用户要求的多个真实公网热点来源调研。

## “要做”和“不做” (Goals / Non-Goals)

目标：

- 自然语言需求直接包含至少三个不同真实公网域名的 URL。
- 仅在独立执行确认后，由 workflow effect 内的 Eidolon actor 实际访问每个来源。
- 报告包含每个来源返回内容中的动态证据，而不是预置固定趋势文本。
- 保留稳定的脚本化模型 adapter，隔离模型服务与生成随机性。

非目标：

- 不把公网网页内容固化为 fixture。
- 不要求公共网站内容永远保持相同标题或 JSON 结构之外的展示细节。
- 不新增 workflow 专用网络实现或绕过标准 Eidolon tool。

## 变更内容（What Changes）

- 将 TUI workflow journey 的单一 localhost 门户替换为 Hacker News、GitHub 与 DEV Community 三个真实公网入口。
- 为每个来源执行独立 `curl` tool call，保存来源证据并动态生成报告。
- 增加发布和执行门前零来源访问、执行后完整来源集合、动态报告证据和持久化 run facts 断言。

## 影响范围（Impact）

- 受影响能力：`eidolon-ai-workflow-native-capability/real-tui-human-journey`
- 受影响测试：TUI workflow human journey E2E
- 生产实现：原则上不修改；若真实 E2E 暴露共享路径缺陷，再按红灯证据修复。
