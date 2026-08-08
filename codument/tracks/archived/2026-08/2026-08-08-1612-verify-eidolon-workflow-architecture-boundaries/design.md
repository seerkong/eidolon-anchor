# Design: executable architecture boundary gate

## Seam matrix

1. Resource boundary：workflow manifest 只能是 XNL；解析、lowering、Ctrl/Data execution 来自 depa-flows packages。
2. Root seam：global/workspace roots 由 Eidolon profile/runtime metadata 注入，缺省 authoring ownership 为 `.eidolon/workflows`。
3. Effect boundary：AI agent、tool、human wait 与 Material effect 通过 Eidolon actor/tool/material adapters；runtime-control 保存 lifecycle evidence，workflow store 只保存 workflow facts 和引用。
4. Surface boundary：Eidolon 不提供 MCP；conversation tools、TUI 与 CLI 都投影同一 component/runtime services。

## 验证策略

新增一个 repository-local contract test，扫描受控 production scope 并检查禁止 token、底层 import allowlist、root 与 native surface bindings。动态测试继续证明 XNL loader、两种真实 runtime、effect evidence、four-mount authoring、frozen run recovery 与 CLI/TUI shared binding。静态扫描只锁架构不变量，不替代行为测试。

## 例外

测试中的禁止规则可以出现 MCP/XML 文本；它们不得形成 executable import、server、parser 或 root。通用 Eidolon kernel 的 MCP timeout 规则不属于 workflow 集成 surface。
