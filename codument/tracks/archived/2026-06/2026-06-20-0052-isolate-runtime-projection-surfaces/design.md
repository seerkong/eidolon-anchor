## 上下文

mission 005「Projection / Surface Layer」+「规则五：Projection 不能反写上游」。G-surface-readonly 复评（`analysis/findings.md`）确认 surfaces 已不写 domain truth、不反向 gate live loop（push-projection 侧达标）；残留全在读/拉取侧。约束：本 track 只做 surface 读侧隔离 + 销毁中介 + 契约/测试，不改 domain truth owner、不改 executor prompt build、不重做 backplane、不重写 @opentui 渲染库。

## 方案概览

1. 类型化只读 projection-read 契约
  - 在 `@cell/ai-core-contract` 新增 **ConversationProjectionReadPort**：只读视图方法（如 `loadConversationProjection(sessionDir/actorKey)` → 可见 history/状态只读视图、`loadPendingQuestionsProjection(...)`）。
    - 只读：契约面**不含**任何写/改/销毁方法。
    - 单源：实现委托 backplane 的 `RuntimeRecoveryReadPort.loadConversationSource` / `PersistenceReadPort`，保持单源 + 缺源硬失败语义（不在 surface 复制 loader、不混源）。
2. TUI hydration 改接（残留 #1 + #2）
  - `TuiRuntimeClient.ts` 的 conversation hydration 去掉自建 repository / raw loader（`:33-36, :915, :1071-1093, :1115-1130`），改用注入的 ConversationProjectionReadPort。
  - pending-questions（`:804-820`）改经 projection-read 视图，不再直读 `runtime_state/questionnaires.xnl`。
  - 注入点：`@terminal/organ` 的 `TerminalRuntime.ts`（合法 shared composition path）组装并注入 port 实例到 surface client。
3. session 销毁经 domain 能力（残留 #3，规则五）
  - `session.delete()`（`:1764-1777`）改调 domain-owned 删除能力（与 upgrade 已走 shared capability 对称），surface 不再直接 `rm` session 真源目录。能力归属：runtime/organ 侧已有 session 生命周期能力处（删除作为其一职）。
4. 只读不变量固化 + guard 扩展（残留 #6）
  - 扩展 `surface-entry-boundary.test.ts` 的源级守卫覆盖 `TuiRuntimeClient.ts`（不止 11 个 entry），断言无 domain 写 API / 无自建 repo 绕过。
  - 复用复评结论把「no surface domain writes」「no surface loop gate」做成可执行 conformance。
5. 跨 surface 等价测试（残留 #5）
  - same-live-loop / different-surface domain 等价测试：同一 profile/输入，分别经 TUI 与 CLI/headless，断言 domain 真源（可见 history、tool 结果配对、turn 结果）等价，差异仅限 surface 呈现。

## 影响范围与修改点（Impact）
- 新增 `@cell/ai-core-contract` ConversationProjectionReadPort 契约 + 只读实现（消费 backplane read port）。
- `terminal/packages/tui/.../TuiRuntimeClient.ts`：hydration / pending-questions / session.delete 改接。
- `terminal/packages/organ/.../TerminalRuntime.ts`：注入 projection-read port。
- `terminal/packages/organ-support/tests/surface-entry-boundary.test.ts`：guard 扩展。
- domain-owned session 删除能力所在模块（runtime/organ 侧）。
- 新增跨 surface 等价测试。

## 决策摘要
- 详见 `decisions.md`。关键：D1 全部读侧残留入范围；D2 session.delete 本 track 内经 domain 能力路由；D3 沿用 backplane 执行模式（manual + GapLoop 终态 + AttractorCheck 每 phase）。

## 风险 / 权衡
- **风险**：TUI hydration 改接触及启动路径，回归面在 terminal/tui（基线有少量预存 terminal 失败）。→ 缓解：分阶段（先契约+实现，再 TUI 改接，再销毁中介，再等价测试+guard），每阶段对 cell+terminal 基线按名比对 0 新增。
- **风险**：projection-read port 若语义与 backplane 单源读取不一致会引入第二来源。→ 缓解：实现**仅委托** backplane read port，不复制 loader；契约只读、无写面。
- **风险**：session.delete 改经 domain 能力是 surface 行为变更（删除路径）。→ 缓解：保持用户可见删除语义不变，仅把执行从 surface fs rm 换成 domain 能力调用；保留 surface 自有 sidecar 清理。

## 兼容性设计
- projection-read port 是新增只读间接层；push-projection 侧不变。
- surface 自有 sink（tui-session.json、UX 缓存、CLI 输出、observability journal）保持原样。

## 迁移计划
- P1 ConversationProjectionReadPort 契约 + 只读实现（先红测试）。
- P2 TUI hydration + pending-questions 改接 projection-read port。
- P3 session 销毁经 domain 能力中介。
- P4 跨 surface 等价测试 + boundary guard 扩展覆盖 TuiRuntimeClient。
- P5 全量回归（cell + terminal 按名比对基线）+ spec 覆盖 + 收尾。
- 回滚：port 是新增间接层，可逐阶段 git revert。

## 待解决问题
- domain-owned session 删除能力的确切归属（runtime/organ 侧现有 session 生命周期能力 vs 新增）——P3 开始时定。
- ConversationProjectionReadPort 实现放 `@cell/ai-core-logic`/`ai-organ-logic` 还是 `ai-persistence-logic`——P1 视依赖方向定（只读、消费 backplane read port，避免环）。
