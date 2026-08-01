# 变更：隔离运行时投影/表现层（isolate-runtime-projection-surfaces）

## 背景和动机 (Context And Why)

runtime-evolution mission（Track-7，Surface 扩展面）的最后一条结构性 track。前序门控全部满足：profile/capability boundary、semantic conversation spine、turn/tool/provider lifecycle、persistent-session-backplane 均已归档。

独立的 **surface write audit**（G-surface-readonly 复评，见 `analysis/findings.md`）确认：surfaces 已经**不写 domain truth、不反向 gate live loop**——push-projection 侧（TuiProjectionGraph、SessionTraceStore、ActorSurfaceProjectionData）完全达标。Gate 仍为 **partial** 的唯一原因在**读/拉取侧**：TUI hydration 自建 repository 直读单源、复制单源 loader 逻辑、绕过 backplane 新建的 `RuntimeRecoveryReadPort` 单源硬失败；pending-questions 直读原始 `questionnaires.xnl`；`session.delete()` 从 surface 直接 `rm` 整个 session 真源目录（违反 005「规则五：projection 不能销毁上游」）；且缺少同一 live loop / 不同 surface 的 domain 等价测试（原始 TUI vs CLI 分歧症状）。

本 track 把这些**读侧软耦合硬化为类型化、只读的 projection-read 边界**，并把 surface 的破坏性 session 销毁经 domain 能力中介，最后用跨 surface 等价测试守护「同一 loop、不同表现 = 同一 domain 行为」。这是 mission 事实边界论在**表现层侧的收口**，也兑现 backplane track 决策 3 推迟的 TUI 读取器改接。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 新增类型化、只读的 **ConversationProjectionReadPort**（`@cell/ai-core-contract`），消费 backplane 单源真源；surface SHALL 只经此 port 做 hydration 读取。
- 把 **TUI conversation hydration**（自建 repo / 复制单源 loader）与 **pending-questions** 读取改接到该 projection-read port，去除 surface 自建 repository 绕过单源。
- 把 surface 的 **session 销毁**改为经 **domain-owned 删除能力**中介，surface 不再直接 rm session 真源目录（修规则五隐患）。
- 把 **G-surface-readonly** 固化为可执行不变量：surface 不写 domain truth、不 gate live loop；**扩展 boundary guard** 覆盖 `TuiRuntimeClient.ts`（不止 entry 文件）。
- 加 **same-live-loop / different-surface domain 等价测试**（TUI / CLI / headless）。

**非目标:**
- 不改 domain truth owner（conversation/tool/provider/turn 域的事实语义，前序 track 已做）。
- 不改 executor 的 provider prompt 构建（`buildProviderPromptForActorTurn` 已是 domain_materialization，审计确认干净）。
- 不重做 persistence backplane（本 track 只**消费**其 read port）。
- 不重写 vendored `@opentui` 渲染库（`terminal/` 根）。
- 不把 composition 移出 `@terminal/organ` 的 `TerminalRuntime.ts`（合法 shared composition path）。
- 不动 surface 自有 sink（`tui-session.json` sidecar、prompt-history/frecency UX 缓存、CLI 输出/trace、observability journal）。
- 不改 push-projection 侧（已达标）。

## 变更内容（What Changes）
- 新增 **ConversationProjectionReadPort**（只读 projection-read 契约）+ 其实现（消费 backplane `RuntimeRecoveryReadPort` / `PersistenceReadPort` 单源读取）。
- **BREAKING（surface 内部）**：TUI hydration 不再自建 conversation/persistence repository，改经注入的 projection-read port；pending-questions 改经类型化 projection-read 视图，不再直读 `questionnaires.xnl`。
- surface `session.delete()` 改调 domain-owned 删除能力；surface 不再直接 `rm` session 真源目录。
- 扩展 `surface-entry-boundary` 守卫覆盖 `TuiRuntimeClient.ts` 等真正读取/重建点。
- 新增 same-live-loop/different-surface domain 等价测试。

## 影响范围（Impact）
- 受影响能力（behaviors）：`runtime-projection-surfaces`（新）。
- 受影响代码：`terminal/packages/tui/.../TuiRuntimeClient.ts`（hydration / pending-questions / session.delete）、`terminal/packages/organ-support/tests/surface-entry-boundary.test.ts`（guard 扩展）、`cell/packages/ai-core-contract/src/runtime/`（新 ConversationProjectionReadPort）、消费 backplane `RecoveryReadPort`/`PersistencePorts`、surface composition 注入点（`@terminal/organ` TerminalRuntime 注入 port）、domain-owned session 删除能力所在处。
- 相邻 track：`refactor-persistent-session-backplane`（已归档，提供单源 read port，本 track 消费）；`complete-runtime-evolution-migration`（W4 收口，承接全层迁移扫尾）。
