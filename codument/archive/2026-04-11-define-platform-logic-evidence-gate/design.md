# 设计：platform-logic evidence gate

## 1. 目标

把“暂不引入 `platform-logic`”从口头原则变成正式治理规则。

## 2. 证据候选

- 第二个非 AI 领域真实出现
- 同一类 runtime logic 已在多个领域重复实现
- 现有 `platform-support` / `mod-platform-kernel` 已无法承载且 ownership 清晰

## 3. 非目标

- 不实现空 `platform-logic`
- 不为了凑最终结构而搬运单领域逻辑

## 4. 结果

后续若出现平台逻辑扩展需求，可以按证据门槛判断，而不是重新争论抽象原则。
