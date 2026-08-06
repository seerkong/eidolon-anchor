# Mission Design

## 控制目标

Desired state：

- `read` 工具对齐 Claude Code Read 语义：默认 limit 2000、offset 1 起始、>2000 行截断到前 2000 行、`<context-resource>` header 带 `total-lines` 属性；目录默认与文件默认一致，目录也带 total 元信息。
- 文件大小/总行数元信息在读取前可得（方向 C），模型据此决定读取范围。
- `ContextResourceLoadDecision.deriveVisibleResourceCoverage` 把 `delivered_and_compacted` 引用视为已可见（复用 resource fact deliveries 中的原始 range）；`pending_first_delivery_compacted` 不视为可见；already-visible 返回值带恢复路径提示；可见性按 range 精确判定。
- 压缩阈值可配置；第三 track 等用户提供通用配置机制后落地。

Actual state：

- `read` 默认 2000 行（[Read/Logic.ts:55](cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Read/Logic.ts:55)），但目录默认 200 条（[:43](cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Read/Logic.ts:43)），同一工具两种默认；`read` schema 未描述 limit/offset 语义。
- 工具提示词（`briefPromptXnl`/`detailPromptXnl`）未进入模型提示词，模型靠训练习惯按 ~200 行翻页。
- `deriveVisibleResourceCoverage` 仅按"当前 content 与完整 outputText 字符串全等"判定可见（[ContextResourceLoadDecision.ts:142](cell/packages/ai-organ-logic/src/runtime/ContextResourceLoadDecision.ts:142)），不识别 `delivered_and_compacted` / `pending_first_delivery_compacted` 两种状态（[AiAgentExecutor.ts:818](cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts:818)）。
- 压缩阈值硬编码在 [AiAgentExecutor.ts:779-784](cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts:779) 与 [:798-803](cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts:798)；函数默认值在 [ContextCompressor.ts:229-231](cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts:229) 与 [:269-271](cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts:269)。

Actuation：

- 创建并执行三个真实 Codument track。
- Track 1 对齐 read 行为与元信息；Track 2 修复已压缩引用可见性；Track 3 把压缩阈值参数化（等用户配置机制）。
- 每个 track 完成后用工具测试、loader 测试或配置证据更新 mission actual state。

Feedback / drift：

- 如果 Claude Code Read 语义细节与预期不符（如截断行号格式），以用户对 A/B/C 的决策为准受控修订 track。
- 如果 compaction 状态枚举或 delivery 结构在实现中发现缺口，先记录 gap 再决定是否扩展。
- 第三 track 在用户提供通用配置机制方案后，按方案受控重规划 G4；到达 human confirm 即停下等待用户。

## 事实源

- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Read/`
- `cell/packages/ai-organ-logic/src/runtime/LocalTextResourceLoader.ts`
- `cell/packages/ai-organ-logic/src/runtime/ContextResourceLoadDecision.ts`
- `cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts`
- `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`
- 行为登记表：`codument/behaviors/progressive-context-resource-loading.xml`（MODIFIED，Track 2）、`codument/behaviors/local-coding-tool-permission-controls.xml`（read 权限上下文）

## 计划 vs track 区分

mission 只负责期望态 DAG、事实边界与 track 编排；真实代码、规范、测试由三个真实 track 承担。Track 3 是刻意不完整的占位 track：proposal.md 只记录已收集的隐式默认值位置/文件/传递逻辑，track.xml 的唯一任务带 human confirm，到达即停。

## 受控重规划

active mission 可以增删改节点和 DAG，但必须有 evidence 或 human decision，并写 `reports/replan-XXX.md`。已知的重规划触发：用户提供通用配置机制方案时，重规划 G4 展开为实际实现任务。
