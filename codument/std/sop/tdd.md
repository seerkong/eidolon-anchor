# TDD 套路（std/sop/tdd.md）

> `codument-implement` 引用的标准执行方法论。

每个功能性 Task 按"测试先行 → 实现 → 重构"循环，直到验收满足：

```text
@delimiter: --
-- #loop ?tdd until="cdt:Acceptance 全部满足 且 测试通过"
---- #step ?red
写测试：据 behavior delta 的 <suite>/<case>（given/when/then）与 cdt:Acceptance 写失败测试
---- /?red
---- #step ?green
实现：写最小实现让测试通过
---- /?green
---- #step ?refactor
重构：在测试保护下清理
---- /?refactor
-- /?tdd
```

- 子代理执行单个 Task 时按此套路；产物落到该 Task/phase 的 output MaterialBundle 目录。
- 验收：`cdt:Acceptance` 勾选 + 测试通过；`codument-verify` 会独立复跑。
- 重构、迁移、类型收紧、性能优化等**声称行为不变**的任务，先补 characterization / freeze 测试或等价的机械基线，锁住现有外部行为，再改实现；diff 审查应确认运行时语义没有无关变化。
- 机制性防回退优先于口头约定：能用棘轮配置、公开表面冻结测试、架构断言、反例注入验红等方式守住的规则，不只写在文档里。
- 非 TDD 适用场景（探索、配置）可降级，但行为用例仍是验收依据；降级原因与实证结论写入 `analysis/findings.md`。
