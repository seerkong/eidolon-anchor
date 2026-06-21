# 设计：AI-first 两层微内核剩余 gap 收敛

## 1. 最终目标

本 track 服务的最终目标是：

1. 平台微内核
   - 承担跨领域可复用的执行平台能力
2. AI 领域微内核
   - 承担 AI runtime 的 provider、tool、questionnaire、semantic event、member/holon 与 AI persistence 语义
3. app overlay
   - 在 AI domain kernel 之上叠加具体产品 overlay，例如 coding

正式组合顺序保持：

1. `platform-only`
2. `ai-kernel`
3. `ai-coding`

这一定义是 AI-first 的：

- AI 是当前唯一正式领域
- 平台层先为 AI 服务
- 但平台层边界必须保留未来承载第二领域的可能

## 2. 当前状态判断

当前仓库已经具备：

- 正式 profile layering
- 非空 `platform-support` 与 `mod-platform-kernel`
- `domain-ai-contract` / `domain-ai-logic` 显式宿主
- VM 中的 platform / AI facet 切分
- shell 对 slash capability 与 assembly result 的正式消费

但当前还不能把“平台微内核已被充分验证”与“AI-first 架构已成立”混为一谈。

更准确的当前判断是：

- 两层微内核已经成立到可继续增量演进的程度
- 当前 track 范围内原先的五类 gap 已完成本轮目标收口
- 后续若继续提高平台厚度、宿主真相源纯度或第二领域证据强度，应通过新的 follow-up track 继续推进
- `platform-logic` 尚不是当前缺口，而是继续受更严格 evidence gate 约束的候选后续层

## 3. 五类 gap

### 3.1 Gap A: 平台微内核仍偏薄，且仍带少量历史 AI/runtime 依赖

问题本质：

- 当前平台层已成立，但还偏向最小 baseline
- 已证明可复用的平台能力仍集中在 profile、bootstrap、project-root locator、runtime registry seeding 等较窄能力面
- `platform-support` 与 `mod-platform-kernel` 仍通过当前 AI runtime 骨架中的部分类型与实现承载 baseline
- 尚未充分证明该 baseline 足以承载第二领域

目标：

- 在不引入无证据 `platform-logic` 的前提下，补强平台 baseline 的实际可复用能力面
- 减少平台侧对历史 AI/runtime 骨架的非必要依赖
- 明确哪些能力继续留在 `platform-support` / `mod-platform-kernel`
- 明确哪些能力仍不应上收到平台层

### 3.2 Gap B: domain-ai 宿主已显式化，但真相源仍未充分收拢

问题本质：

- `domain-ai-*` 已成为正式宿主
- 但不少 contract / logic 仍通过 `core-*` / `organ-*` 透传或 re-export 暴露
- 这会让 AI 领域宿主长期停留在“入口成立，但真相源未收口”的中间态

目标：

- 让 `domain-ai-*` 成为默认消费入口与第一批真实宿主
- 优先迁移 host-facing glue、ownership 与对外 contract surface
- 保持底层 primitive 的增量迁移，不做大爆炸式搬迁

### 3.3 Gap C: shell bridge 仍偏厚

问题本质：

- shell 已不再持有默认产品组合真相
- 但 terminal / tui / headless 仍直接知道较多 AI runtime glue
- 这会拖慢 shell 向 platform-neutral bridge 的进一步收敛

目标：

- 定义更窄的 domain facade port
- 让 shell 优先消费 facade，而不是继续直接拼 coordinator / organization / projection glue

### 3.4 Gap D: 命名与类型外形仍泄露 AI 默认形状

问题本质：

- 平台与 domain 的 ownership 已比历史状态清晰
- 但外露类型名与部分 contract surface 仍持续暗示“AI 是默认 runtime 形状”
- 这会影响后续引入第二领域时的边界判断

目标：

- 逐步减少更通用边界上泄露的 AI-shaped 命名与类型耦合
- 优先修正影响 ownership 判断的外露面
- 避免一次性破坏性 rename

### 3.5 Gap E: 尚未通过第二领域或真实重复实现验证平台层边界

问题本质：

- 当前平台层是从 AI-first 重构中抽出的
- 这证明了“平台边界可被设计出来”
- 但尚未充分证明“平台边界真的对第二领域成立”

目标：

- 通过足够强的第二领域证据，或通过更强的真实重复实现证据，验证平台边界
- 在证据不足，或尚未证明确有独立层需求前，禁止无证据创建 `platform-logic`

非目标澄清：

- 这不是要求当前 session 直接实现第二领域
- 这也不是要求为了验证而制造空洞的 `platform-logic`

## 4. 执行原则

### 4.1 先收口真相源，再追求目录纯度

- 优先级高于物理包 rename
- 优先级高于结构对称

### 4.2 先收紧 shell facade，再扩大平台宣称

- shell 仍是最容易回流真相源的入口
- 不先收紧 shell，平台层声明会继续偏乐观

### 4.3 platform-logic 继续受 evidence gate 约束

以下都不构成创建 `platform-logic` 的证据：

- 只是因为目标图中有这一层
- 只是因为 AI 域逻辑仍然很多
- 只是因为想让 platform/domain 更对称
- 只是因为已经出现了最小第二领域 spike

### 4.4 继续保护 AI runtime 连续可运行

- terminal / tui / headless 主路径不能在 gap 关闭过程中被打断
- 每一阶段都要通过 focused verification 验证 adoption 与 ownership

### 4.5 将“成立”与“充分验证”分开管理

- “两层微内核已成立”允许继续做增量实现
- “平台微内核已被充分验证”仍需要更强证据
- 计划与验收必须明确当前是在关闭哪一类 gap，避免提前宣告完成

## 5. focused verification 基线

### 5.1 Platform Baseline Verification

- `platform-only` 不隐式注入 AI domain 能力
- `platform-support` / `mod-platform-kernel` 的职责边界清晰且可测试
- 平台侧新引入能力不回流明显的 domain-ai / organ 依赖

### 5.2 Domain Host Verification

- 新 consumer 默认优先走 `domain-ai-*`
- `domain-ai-*` 不再只是 forwarding shell
- 外露 contract / logic surface 对 `core-*` / `organ-*` 的直接透传继续减少

### 5.3 Shell Facade Verification

- shell 主路径优先依赖 facade
- 不再直接持有第二套 slash/help/config/orchestration 真相源
- `TerminalRuntime` 对具体 AI glue 的直接编排职责继续下降

### 5.4 Ownership Leakage Verification

- 平台边界外露面中 AI 默认形状持续减少
- 新引入 API 不回流明显 AI-shaped 依赖到更通用层

### 5.5 Evidence Gate Verification

- 若尚未出现足够强的第二领域或重复实现证据，则不得引入 `platform-logic`
- 即使已经出现最小第二领域 spike，也仍必须证明确有独立 `platform-logic` 层需求
- 若执行第二领域 spike，则必须明确记录可复用部分、未证明部分与失败点

## 6. 完成判据

满足以下条件时，可视为本总 track 达成。当前 track 已满足这些条件：

- 平台 baseline 的“偏薄 + 历史依赖残留”问题已得到明确补强、收紧或被证伪记录
- `domain-ai-*` 的默认宿主与真实宿主收口进一步推进
- shell bridge 对 AI glue 的直接依赖继续下降
- AI 默认形状泄露被纳入持续治理
- 对平台通用性给出更严格的证据性判断，而不再只停留在 AI-first 内部证明

## 7. 新 Session 执行入口

下一次新 session 若仍进入本 track，默认执行顺序应为：

1. 读取 `context.md`
2. 执行严格校验，并准备 archive
3. 若目标是继续扩大成熟度工作，则新建 follow-up track，而不是重新打开本 track 的旧阶段

停止条件：

- 如果拟引入的能力开始逼近 `platform-logic`，必须先对照 evidence gate
- 如果改动会打断 terminal / tui / headless 主路径，必须先补 focused verification 再继续

## 8. 当前实现结果与后续建议

当前 track 已完成的关键收口：

- `mod-platform-kernel` 已停止依赖 AI-shaped `@cell/composer/ai-contract`
- shell runtime bootstrap / recovery glue 已回收到 `domain-ai-logic`
- shell-facing runtime surface 已优先提供 `DomainRuntimeVm` / `DomainRuntimeDriver` / `DomainRuntimeCoordinator`
- `domain-ai-contract` 的 assembly contract type 已切到 `DomainRuntimeAssembly*`
- `domain-ai-logic` 根入口已停止直通一批 legacy runtime primitives，并改为 domain-owned root names
- focused guard 已覆盖 platform import leakage 与 `platform-logic` evidence gate
- `Gap E` 已形成结构化证据矩阵，明确了：
  - 哪些平台 baseline 已被证明可复用
  - 哪些部分仍只停留在 AI-first 内部证明
- `Gap E` 已新增最小第二领域 spike 的正向证据：
  - 非 AI domain 可以复用 `mod-platform-kernel` + `platform-support` 站上当前平台 baseline
- evidence 结论已明确区分：
  - “平台 baseline 可复用”
  - “存在最小第二领域 spike 的正向复用证据”
  - “尚未证明需要或允许 `platform-logic`”

本 track 结束后的后续建议：

1. 当前 track 已可归档
2. 若继续推进 shell slimming，单独起新 track 聚焦 slash/MCP/lifecycle glue
3. 若后续仍需要更长线的跨领域验证，再单独起 evidence track
