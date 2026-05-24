# 设计：platform kernel baseline and support seeding

## 1. 目标

补齐平台微内核最缺的“实体层”：

- 非空 `platform-only`
- 第一版 `mod-platform-kernel`
- 第一批真实 `platform-support`

## 2. 候选能力

优先考虑：

- 通用 bootstrap/policy/hook pipeline 的平台部分
- 非 AI 语义的 shell/runtime bridge capability
- 不依赖 provider/model/skill/agent identity 的 support 实现

## 3. 风险控制

- 不为了凑平台包而强行上收 AI support
- 只迁第一批有明确跨领域复用证据的能力

## 4. Focused Verification

- `platform-only` capability tests
- profile layering tests
- support ownership tests
