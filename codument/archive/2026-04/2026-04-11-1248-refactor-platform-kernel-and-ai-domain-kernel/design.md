# 设计：平台微内核与 AI 领域微内核分层

## 1. 设计结论

本项目不应直接追求“一个完全无领域的万能微内核”，而应采用两层方案：

1. 平台微内核
   - 负责跨领域可复用的执行平台能力
2. AI 领域微内核
   - 负责 AI runtime 特有的协作、语义与工具链能力

这样既能避免未来重复搭建多套微内核，也能避免为了通用而把 AI 语义抽空。

## 2. 平台微内核边界

平台微内核应包含：

- actor / fiber / mailbox / selective receive
- append-only event log / ordered timeline / reducer projection
- manifest / variant / bundle / registry composition
- profile / bootstrap / capability registry
- hook runtime / permission / policy pipeline
- diagnostics / replay / trace runtime
- persistence ports 与 support capability contract
- shell bridge 所依赖的通用 runtime contract

这些能力应优先建立在以下 vendor 原语之上：

- `vendor/depa-actor`
- `vendor/depa-processor`
- `vendor/depa-data-graph`

## 3. AI 领域微内核边界

AI 领域微内核应继续拥有：

- provider / model runtime
- tool calling protocol
- questionnaire / approval / human pause-resume
- AI semantic event taxonomy
- agent / member / teammate / holon 语义
- AI runtime persistence model
- AI slash namespace 与 direct action contract

原则：

- 平台层定义“如何组合与运行”
- AI 层定义“AI runtime 到底运行什么语义”

## 4. 目标包结构

建议目标结构如下：

- `vendor/*`
  - 保留最底层通用原语
- `platform-contract`
  - 平台协议边界
- `platform-logic`
  - 平台内核执行逻辑
- `platform-support`
  - 本地文件 / SQLite / HTTP 等环境实现
- `domain-ai-contract`
  - AI 领域 contract
- `domain-ai-logic`
  - AI 领域 orchestration
- `domain-ai-support`
  - AI 领域环境实现
- `mod-platform-kernel`
  - 平台基线能力
- `mod-ai-kernel`
  - AI 领域基线能力
- `mod-ai-coding`
  - coding app overlay

在本仓库中，不要求立即改名到上述包名，但迁移方向应与该结构一致。

## 5. 与当前 cell 分层的关系

当前仓库已经有一条可延续的演进路径：

- `core-contract / core-logic / organ-contract / organ-logic / organ-support`
- `composer + mod-profiles + mod-sys-kernel + mod-sys-coding`

本次设计建议：

- 继续利用现有 `composer + mod profile` 作为 profile 装配入口
- 先把 `core-*` 中真正跨领域可复用的能力向平台边界收口
- 将 AI 形状明显的 runtime state、assembly contract、slash surface、semantic contract 保留在 AI 领域边界
- 将 `mod-sys-kernel` 重定位为 AI domain kernel baseline，而不是误认成平台 kernel baseline

## 6. profile 叠加模型

推荐 profile 叠加顺序：

1. `platform-only`
2. `ai-kernel`
3. `ai-coding`

未来新增领域时：

1. `platform-only`
2. `domain-x-kernel`
3. `domain-x-app`

这意味着：

- profile 是正式的产品组合入口
- 平台内核不能假定“当前领域一定是 AI”
- 各领域只需在平台基线上定义自己的 kernel 与 app overlay

## 7. 迁移策略

### 7.1 第一阶段：边界冻结

- 明确哪些 contract/logic 属于平台
- 明确哪些 runtime facet 仍属于 AI
- 冻结禁止项，防止为了“通用”而过早抽象

### 7.2 第二阶段：contract 提升

- 将 composer assembly contract 从 AI-shaped surface 提升为更通用的 capability composition contract
- 将 VM/runtime state 切分为 platform facet 与 AI facet

### 7.3 第三阶段：profile 与 mod 重排

- 增加 platform baseline profile
- 将当前 kernel/coding profile 调整为在 platform 之上叠加

### 7.4 第四阶段：shell 与 support adoption

- 让 terminal/tui/headless 只消费 assembly result 与 capability ports
- 让 support 实现各自归位到平台 support 或 AI support

### 7.5 第五阶段：验证与 cutover

- focused tests 验证 ownership、profile 顺序、capability 缺失语义、runtime adoption
- 确保当前 AI runtime 不回退

## 8. 反模式

以下做法应明确避免：

- 为了未来可能复用而抽出没有真实共性的 capability
- 将 AI 领域语义硬塞进平台内核
- 在 platform 与 domain 两侧平行维护两份 registry/profile/bootstrap 真相源
- 重新造一套与 vendor 重复的 actor/dispatch/projection 基础设施

## 9. 成功标准

达到以下条件时，可认为架构升级成功：

- 新领域可以复用平台微内核而不依赖 AI runtime
- AI runtime 继续作为平台上的一个领域内核存在
- shell/runtime entry 不再定义默认产品语义
- profile 成为唯一正式产品组合入口
- vendor 原语继续作为基础而不是被旁路
