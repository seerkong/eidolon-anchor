# skill: codument-impl-quick（基于 Codument 上下文快速实现小改动）

用于小范围变更：bug 修复、测试补齐、局部重构、非破坏性配置修正。它读取 Codument 知识上下文和项目工程文件后直接实现，不创建 track、mission、proposal 或 behavior delta。

## 0. 边界

适合 quick：

- 恢复既有预期行为的 bug fix。
- 小范围测试补齐。
- 局部重构且不改变对外行为。
- 非破坏性配置/脚本修正。

不适合 quick：

- 新能力或对外行为变化。
- 需要 behavior/modeling/engineering delta 才能表达清楚的变更。
- 架构/模式调整。
- 多阶段或跨模块高风险工作。
- 长期自动化目标。

遇到不适合 quick 的工作，停止并建议 `codument-plan-track` 或 `codument-plan-mission`。

## 1. 上下文加载

1. 直接读取与目标相关的项目约束、代码和测试；仅当 `action-hooks.xml` 显式为 `impl-quick:before` 配置 `<cdt:AttractorCheck>` 时才执行 fresh check。
2. 读取与请求相关的：
   - `codument/attractors/`、`codument/std/attractors/`。
   - `codument/behaviors/`。
   - `codument/modeling/`、`codument/engineering/`（如果存在）。
   - `codument/decisions/` 与相关 archive/track 历史。
   - 源码、测试、配置、脚本。

## 2. 实现流程

```text
@delimiter: --
-- #sequence ?quick
---- #step ?scope
判断请求是否适合 quick；不适合则 #exit 并建议 plan-track / plan-mission
---- /?scope
---- #step ?context
读取 Codument owner 知识和相关工程文件，形成最小上下文
---- /?context
---- #step ?edit
按项目既有模式做最小代码/测试/配置修改
---- /?edit
---- #step ?verify
运行最小必要验证；能跑测试就跑，不能跑则说明原因
---- /?verify
---- #step ?durable
判断是否发现稳定结构知识或工程知识；如有，只提示是否写入 codument/modeling 或 codument/engineering，不静默沉淀
---- /?durable
---- #return ?done value="quick implementation complete"
---- /?done
-- /?quick
```

## 3. 知识沉淀

默认不创建 track、不写 proposal、不写 behavior delta。

若实现过程中发现稳定长期知识：

- 领域结构、对象、状态机、policy、workflow → 提示是否写入 `codument/modeling`。
- 工程规则、howto、troubleshooting、code-map、runbook → 提示是否写入 `codument/engineering`。
- 对外行为变化 → quick 不再合适，建议创建 track。

未经用户明确同意，不要把 quick 中发现的知识直接沉淀为 durable owner registry。

## 4. 输出

最终回复包含：

- 修改摘要。
- 验证结果。
- 是否仍属于 quick。
- 是否发现建议沉淀到 `codument/modeling` / `codument/engineering` 的长期知识。
- 若未能验证，说明原因和剩余风险。
