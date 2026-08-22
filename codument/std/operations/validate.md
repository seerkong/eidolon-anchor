# skill: codument-validate（校验 Codument 资源）

校验 Track、Mission、BehaviorPatch、Behavior、Decision 及相关 registry。CLI 是语法、Kind 版本、结构、引用、DAG 与 hook 规则的确定性 authority；AI 只补充程序无法证明的语义审查。

## 主流程

```text
@delimiter: --
-- #sequence ?validate
---- #step ?run
运行 `codument validate [item] [--strict]`。
---- /?run
---- #if ?diagnostics cond="CLI 返回 diagnostics"
按 rule、file、message 修正输入并重跑同一命令，直到通过或确认存在真实阻塞。
---- /?diagnostics
---- #step ?semantic
CLI 通过后，检查目标、范围、验收、风险和任务覆盖是否在业务语义上自洽。
---- /?semantic
---- #return ?verdict
报告 CLI 结论、语义风险和未执行项。
---- /?verdict
-- /?validate
```

## 语义审查

CLI 已覆盖的结构规则以当前 KindDefinition 和以下规范为准，不在提示词中复制：

- `std/spec/track-xnl-spec.md`
- `std/spec/mission-xnl-spec.md`
- `std/spec/behavior-delta.md`
- `std/spec/decision-registry.md`
- `std/spec/modeling-node-schema.md`
- `std/spec/engineering-node-schema.md`

AI 审查聚焦：

- proposal 的背景、目标、非目标和影响是否完整；
- design 是否覆盖关键风险、迁移和回退；
- behavior 与 Acceptance 是否表达真实、可验证的结果；
- TaskSpace、Schedule 和物料是否覆盖目标，而非只在结构上合法；
- Decision 的问题、选项、推荐、反馈与证据是否能解释真实取舍。

语义判断应与 CLI diagnostics 分开陈述，不把推断伪装成机器校验结果。

## CLI 不可用

若系统找不到 `codument`，结构校验记为 `SKIPPED` 并说明缺失的机器保证。只读语义 review 可以继续；任何依赖校验后写入、迁移或归档的流程保持 blocked，不用提示词重写一套解析器或事务实现。

## 独立验证

调用方要求 fresh validator 时，派独立子代理运行同一 `codument validate` 命令并做上述语义审查。子代理只返回 findings 与 verdict，不修改实现；修复仍由调用方负责。

## 输出

输出必须包含：校验范围、运行的命令、CLI PASS/FAIL/SKIPPED、按严重度排序的 diagnostics、语义风险和最终 verdict。
