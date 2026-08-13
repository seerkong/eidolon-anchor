## 上下文

Runtime 已经把 provider semantic events 统一投影为 `TuiControl + chunk`，并让 `turn` 与 `resumeTurn` 共用同一入口。缺口位于 TUI surface：三条产品入口复制投影状态，continuation 未接 control；历史重建再以随机 id 全量替换。权限侧则缺少“workspace 操作”与“明确外部访问”的结构化意图边界。

## 方案概览

1. 单一 TUI turn surface projector
   - 在 `TuiRuntimeClient` 附近建立可测试的 projector/state owner，输入为 typed control、chunk、history event、final text 与 durable snapshot。
   - projector 持有 active category、当前 text segment、stream frame buffer、tool parts by stable key、已发 identity。
   - prompt/command/resume 只组装 entry context（parent message、model、agent、调用函数），所有 callbacks 委托同一 projector。
2. live/durable reconciliation
   - live semantic/history 是低延迟 observation；conversation/tool domain 是 durable authority。
   - assistant 使用 conversation `messageId`（缺失时确定性派生），tool 使用 `actorId+toolCallId`，questionnaire 使用 `questionnaireId`，context 使用 resource id+revision+range。
   - resync 按 identity upsert/remove stale derived entries，不再 `splice all + random id`。
3. exhaustive role 与 context resource projection
   - user 才映射 USER；assistant 的 reasoning/text/tool calls 映射相应卡片；tool role 依据 toolCallId/name 重建 ToolPart；system/internal 默认不进入普通消息流。
   - context resource metadata 在 tool result projection 边界结构化携带，并作为 committed tool message 的可选 `resultMetadata` 经过既有 conversation XNL/read port；TUI data/card 层不解析 raw XML。
   - CONTEXT/read 卡片默认显示 workspace-relative path、status、range、size、短 revision，正文折叠；already-visible 弱化。
4. 显式 workspace scope intent
   - 文件工具 schema 共享 `scopeIntent` enum，默认 workspace；ls/glob/grep 省略 path 使用 `.`。
   - evaluator 在 workspace intent 越界时返回 `workspace_scope_violation` 结构化诊断，不产生 approvalGrant。
   - external intent 才复用现有 workspace-access gate；既有持久 grant authority 不变。
   - questionnaire choice 显式表达 one-time read / persistent read / advanced persistent read-write / deny；one-time 只构造当前 replay grant，不写配置。

## 影响范围与修改点（Impact）

- `terminal/packages/tui/src/runtime/client/TuiRuntimeClient.ts`
- `terminal/packages/tui/src/runtime/client/` 新的 projector/reconciler 模块（如拆分有助于测试）
- `terminal/packages/tui/src/app/tui_a1/data.ts` 及必要卡片 renderer
- `cell/packages/ai-organ-logic/src/permissions/LocalPermissionEvaluator.ts`
- `cell/packages/ai-organ-logic/src/permissions/LocalPermissionRuntime.ts`
- `shared/packages/composer`、`cell/packages/ai-organ-contract` 与 `cell/packages/ai-support` 的既有 committed tool message codec（只增加可选 projection metadata）
- 内置文件工具 `OuterTypes.ts`、schema 与 permission payload
- TUI category/questionnaire/history/context 与 permission/file tool tests

## 决策摘要

- 详见 `decisions.xnl`。
- 不改 runtime authority，不做 provider 特判，不做 raw XML/path 文本模糊路由。
- shared projector 是 surface 的派生状态 owner，不是新的 conversation 或 tool truth。
- `scopeIntent` 是调用者结构化意图，不是权限本身；外部访问仍需 policy/grant。

## 风险 / 权衡

- TuiRuntimeClient 体积较大，抽取过程中可能改变事件时序 → 先用三入口 characterization tests 锁序列，再逐入口替换。
- durable history 可能缺失 messageId/tool name → 使用确定性兼容 identity 并保留 unknown tool fallback，禁止随机重建。
- 旧调用未传 scopeIntent → 默认 workspace 是有意的安全收紧；已有 external 自动化需显式补 `external`。
- context resource 当前以 XML 供模型消费 → raw provider history 保持兼容，新增 metadata 只服务 live/durable surface projection，provider request projector 会忽略该字段，不改模型协议。

## 兼容性设计

- headless/CLI 与 provider context 不变。
- 已持久化 workspace-access grants 继续生效，但只有 explicit external intent 才会使用。
- 旧 conversation 缺少稳定 id 时使用内容无关的确定性序号/role/toolCallId 派生，避免每次 hydration 漂移。
- 原有 TUI Event/Message/ToolPart 外形尽量保持；context card 通过 ToolPart metadata 扩展。

## 迁移计划

1. 建立失败测试与共享 projector API。
2. 依次迁移 prompt、command、resume，并删除重复逻辑。
3. 替换 history role mapper/resync，增加 context metadata/card。
4. 收紧 scope intent/grant mode，更新工具 schema 与测试。
5. 运行 TUI、permission、cross-surface 与架构扫描回归。

## 待解决问题

- 无；实现时若发现 runtime history 完全无法携带 context metadata，优先扩展 typed history payload，禁止 UI 解析 XML 兜底。
