## ADDED Requirements

### Requirement: AI-first 两层微内核最终目标必须在 track 内显式自包含

系统 SHALL 在当前 track 中完整描述“两层微内核”作为一版 AI-first 架构的最终目标，而不要求执行者先阅读历史 archive 才能理解本轮目标。

#### Scenario: 新 session 仅阅读当前 track 即可理解目标
- **GIVEN** 一个新的执行 session
- **WHEN** 执行者只读取当前 track 目录下的标准文件与 analysis 文件
- **THEN** 执行者能够明确理解以下正式目标：
- **AND** 平台微内核负责跨领域可复用的执行平台能力
- **AND** AI 领域微内核负责 provider、tool、questionnaire、semantic event、member/holon 与 AI runtime persistence 等 AI 专属语义
- **AND** 正式 profile layering 为 `platform-only -> ai-kernel -> ai-coding`

### Requirement: 当前剩余问题必须被正式收敛为五类 gap

系统 SHALL 将当前“两层微内核”剩余问题收敛为五类正式 gap，并在 track 中记录其边界和完成判据。

#### Scenario: 五类 gap 被完整列出
- **GIVEN** 当前代码库已具备一版 AI-first 两层微内核雏形
- **WHEN** track 定义剩余问题
- **THEN** track 必须至少包含以下五类 gap：
- **AND** 平台微内核仍偏薄
- **AND** 平台 baseline 仍带少量历史 AI/runtime 依赖
- **AND** `domain-ai-*` 宿主已显式化但真相源仍未充分收拢
- **AND** shell bridge 仍偏厚
- **AND** 命名与类型外形仍泄露 AI 默认形状
- **AND** 尚未通过第二领域或真实重复实现验证平台层边界

### Requirement: 平台微内核 gap 不得被错误实现为无证据的 platform-logic 扩张

系统 SHALL 将“平台微内核仍偏薄”定义为 baseline strength 与 cross-domain evidence 问题，而不是默认要求立即创建 `platform-logic`。

#### Scenario: 平台层待补强但无证据创建 platform-logic
- **GIVEN** 当前平台层已存在 `platform-contract`、`platform-support`、`mod-platform-kernel`
- **AND** 尚未出现第二个非 AI 领域
- **WHEN** 执行者推进平台层 gap
- **THEN** 执行者必须优先增强已证明可复用的平台 baseline、support、policy 与 capability 组合边界
- **AND** 不得仅因结构对称或未来可能复用就创建 `platform-logic`

#### Scenario: 平台侧存在过渡性历史依赖时优先做收紧判断
- **GIVEN** `platform-support` 或 `mod-platform-kernel` 仍承载少量来自当前 AI runtime 骨架的类型或实现依赖
- **WHEN** 执行者推进平台层 gap
- **THEN** 应先区分哪些依赖属于当前可接受的 baseline 过渡实现
- **AND** 哪些依赖已经构成平台边界泄露并需要被收紧
- **AND** 不得把所有历史依赖一律等同于必须新建 `platform-logic`

### Requirement: domain-ai 宿主收口必须以减少历史真相源泄露为目标

系统 SHALL 将 `domain-ai-contract` 与 `domain-ai-logic` 视为 AI 领域的正式宿主，并逐步收紧其对 `core-*` / `organ-*` 历史路径的透传依赖。

#### Scenario: consumer 默认入口已切到 domain-ai 但底层仍存在历史透传
- **GIVEN** 外部 consumer 已开始依赖 `@cell/domain-ai-contract` 与 `@cell/domain-ai-logic`
- **WHEN** 执行者推进 domain host gap
- **THEN** 应优先迁移 host-facing glue、contract ownership 和默认消费入口
- **AND** 应减少新的代码继续直接把 `core-*` / `organ-*` 暴露为事实真相源
- **AND** 不要求一次性搬迁所有底层 primitive

#### Scenario: domain-ai 显式宿主与真实宿主需要被分开验证
- **GIVEN** `domain-ai-*` 已经成为默认消费入口
- **WHEN** 判断 AI domain host gap 是否关闭
- **THEN** 必须区分“consumer 已切换到 domain-ai 入口”与“真实实现宿主已充分收口”这两个层次
- **AND** 不得仅因 import 路径已经切换就宣告 gap 完成

### Requirement: shell bridge 收紧必须以窄 facade port 为正式目标

系统 SHALL 要求 terminal / tui / headless 继续从“知道较多 AI glue 的 bridge”收紧为“消费更窄 domain facade port 的 bridge”。

#### Scenario: TerminalRuntime 仍直接知道较多 AI runtime 细节
- **GIVEN** shell 已经消费 assembly result 与 slash capability port
- **AND** `TerminalRuntime` 仍直接知道部分 AI runtime glue
- **WHEN** 执行者推进 shell bridge gap
- **THEN** 应在正式宿主上提供更窄 facade
- **AND** 让 shell 优先依赖 facade 而不是继续直接拼 orchestration 细节
- **AND** 不得为 cutover 临时复制第二套默认行为真相源

### Requirement: AI 默认形状泄露必须被正式识别与逐步收紧

系统 SHALL 将类型名、assembly facet、runtime surface 中持续泄露的 AI 默认形状视为正式 gap，并建立逐步收紧策略。

#### Scenario: AI 语义仍以命名或类型外形泄露到更通用边界
- **GIVEN** VM 已拆分出 platform facet 与 AI facet
- **AND** 顶层类型名、部分 domain contract 仍沿用明显 AI-shaped 命名
- **WHEN** 执行者推进命名与类型外形 gap
- **THEN** 应优先收紧平台边界外露的 AI 默认形状
- **AND** 应避免以破坏性 rename 一次性清空全部历史命名
- **AND** 应以 ownership clarity 优先于目录对称

### Requirement: 平台层成立必须通过第二领域或真实重复实现证据验证

系统 SHALL 将“第二领域验证或真实重复实现证据”作为平台边界最终成立的重要验证条件，而不是只以 AI-first 架构本身作为充分证据。

#### Scenario: 平台层已具备一版 AI-first baseline 但尚无第二领域验证
- **GIVEN** 平台层与 AI 领域层均已有第一版工作实现
- **WHEN** 执行者判断“两层微内核”是否已完全闭合
- **THEN** 必须区分“AI-first 架构已经成立”与“平台微内核已被充分验证”这两个结论
- **AND** 应通过第二领域 spike 或真实重复实现证据来验证平台边界
- **AND** 在证据不足前，不得夸大平台层的通用性结论

### Requirement: 当前 track 必须为新 session 提供可直接接棒的执行上下文

系统 SHALL 在当前 track 中提供足够的执行上下文，使新 session 无需回溯历史 archive 也能从首个未完成任务继续推进。

#### Scenario: 新 session 以当前 track 为唯一入口启动
- **GIVEN** 执行者在新的 session 中进入 `close-ai-first-two-layer-microkernel-gaps`
- **WHEN** 执行者读取当前 track 的标准文件、analysis 文件与执行上下文
- **THEN** 能明确知道当前哪些结论已成立、哪些 gap 尚未关闭、哪些任务仍是 `TODO`
- **AND** 能直接识别默认首轮切入点与停止条件
- **AND** 不需要重新阅读 2026-04-11 的 archive 才能开始执行

## Out Of Scope

- 在本 track 创建阶段直接实施所有代码迁移
- 无证据引入 `platform-logic`
- 一次性全仓 rename 以追求目录对称
- 为了抽象而抽象新的万能 capability taxonomy
