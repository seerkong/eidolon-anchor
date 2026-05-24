# 设计：domain-ai-logic host implementation cutover

## 1. 目标

让 `@cell/domain-ai-logic` 从“显式宿主 + re-export 收口”推进为“第一批真实实现宿主”。

## 2. 迁移原则

- 先迁 host-facing glue，不迁底层 primitive 本体
- 保持 consumer formal host 不变，避免二次 cutover
- 不引入 `platform-logic`
- 不制造第二套 AI runtime 真相源

## 3. 第一批实现范围

- shell runtime facade
- runtime coordinator glue
- host-facing orchestration / projection bridge glue

这些能力直接服务 shell/runtime/composer 侧的 AI runtime adoption，最适合作为 domain host 的第一批正式实现。

## 4. 暂不迁移的内容

- actor primitive
- generic runtime primitive
- stream primitive
- 明显仍属于 `core-logic` 底层或平台形态的基础能力

## 5. 风险

### 风险 1：把底层 primitive 误搬进 AI 宿主

应对：
- 只迁 host-facing glue
- focused tests 明确禁止以“宿主完整”为理由扩大迁移

### 风险 2：迁移后 consumer 行为回归

应对：
- 保持 terminal/tui/headless formal host 不变
- 继续跑 focused adoption tests 与 package ownership guard

## 6. 完成标志

- `domain-ai-logic` 中出现第一批非转发实现
- `TerminalRuntime` 等现有 consumer 无需改 formal import 面
- focused guard 能证明 `domain-ai-logic` 不再只是 forwarding shell
