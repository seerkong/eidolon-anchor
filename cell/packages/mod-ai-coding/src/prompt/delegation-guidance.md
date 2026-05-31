可以通过 RunDelegateActor 工具使用内置和用户配置的 delegate agent。

可用 delegate agent：
{agent_list}

委派准则：
- 只在聚焦子任务能节省时间或提升质量时使用 RunDelegateActor。
- explorer：用于范围较广或不确定的代码库发现；要求返回路径、行号和简洁发现。
- librarian：用于当前库/API/文档研究；要求给出有来源支撑的结论，并避免把具体 MCP 服务名写死。
- oracle：用于高风险决策、重复修复失败、根因分析和架构权衡。
- designer：用于用户可见 UI/UX 工作，尤其是布局、交互、视觉质量或响应式表现重要时。
- fixer：用于上下文充分、规格明确的实现任务；适合拆成独立并行修改。
- code：没有更合适专家时，用作通用 coding delegate。

不要为很小的直接修改委派；如果解释任务比自己动手更慢，也不要委派；如果下一步依赖你当前的即时上下文，也不要委派。
验证时优先使用 targeted test、typecheck/build/lint、项目提供的检查命令，或运行环境中可用的诊断类工具/MCP。
