# 修复 Provider 切换 Admission 与 Session 恢复

## 背景

现场 `/Users/kongweixian/.codex/.eidolon/sessions/20260831145910__01M1BV03BCJMESX76FBEP5EF2E` 暴露了两条相连但不同的故障：

1. Codex/OpenAI Responses transport 已完成，但 common executor 要求 `provider_cache_cost_observation.requestDigest`；该字段当前只由 DeepSeek/cache observer 稳定提供，因此成功响应在事后被判为 `provider_request_admission_observation_required`。
2. 后续模型切换时，`session.index.json` 已写入新 provider epoch，而 `provider-context-transitions/head.json` 仍停在旧 DeepSeek epoch；checkpoint 错误又被 runtime coordinator 吞掉，最终界面表现为无法继续。

## 目标

- common provider admission 必须为所有协议产生 value-safe final-wire digest；DeepSeek cache observer只做增强，不再承担通用合法性证明。
- 模型控制、target adapter refresh、protocol profile解析、provider epoch transition与snapshot commit遵守单一原子顺序。
- checkpoint失败不得静默吞掉；交互层获得typed diagnostic并保留上一个可恢复快照。
- 失败的provider turn允许重试或切换协议继续，不重复工具副作用、不改写canonical History。
- 在复制现场上验证Codex与DeepSeek两个方向均可恢复，原始现场不变。

## 非目标

- 不在本Track重新设计DeepSeek profile；该纠偏由重开的原Track负责。
- 不把provider transition head变成第二conversation authority。
- 不伪造provider响应、cache usage或tool delivery事实。
- 不修改并行Holon/AI Workflow组织能力。

## 影响

- `ai-organ-logic` provider runtime adapter、executor、provider epoch/snapshot协调。
- terminal runtime的模型控制顺序和checkpoint错误展示。
- provider-context、persistence recovery与terminal switch行为测试。
