# Proposal: verify Eidolon workflow architecture boundaries

## 目标

证明 Eidolon workflow 具备四类明确架构边界：资源格式使用 XNL/depa-flows，工程 roots 使用 Eidolon 注入，effect host 使用 Eidolon actor/session/runtime-control，公开 surface 使用 native component/tools/CLI。完整产品协议不得因边界适配而被削弱。

## 必须禁止

- workflow production code 中的 XML authoring/parser 或非 Eidolon workflow-root ownership。
- Eidolon 集成中的 MCP server/client surface。
- 调用任何外部 agent CLI。
- 自建 AICtrlWorkflow/AIDataWorkflow parser、scheduler、data-flow/work-flow authority。
- CLI/TUI/tool 私有 mutation、绕过 confirmation/proof 的 publication 或 execution。

## 成功标准

静态 boundary contract、depa-flows loader/runtime tests、Eidolon effect evidence、TUI/CLI binding、compiled smoke 与 strict validation 同时通过，且 boundary matrix 每项都有 owner 和自动化证据。
