# 讨论记录

## Phase P1: Architecture Boundary Freeze

### 讨论时间
2026-04-10T19:43:01Z

### 关键决策
1. **平台微内核最小能力范围**：平台微内核只覆盖以下最小必要能力：
   - actor / fiber / mailbox
   - manifest / bundle / profile / bootstrap
   - event log / projection / replay
   - hook / permission / policy
   - 理由：这些能力具备明确跨领域复用价值，且不会天然绑定 AI 语义。

2. **持久化不纳入平台微内核能力清单**：`persistence effect ports` 或包含领域状态建模的持久化能力不作为平台微内核正式能力。
   - 理由：不同业务领域会拥有不同的状态模型与持久化语义，把它们上收到平台层会过早绑定领域假设。

3. **AI 领域能力留在 AI 微内核**：以下能力明确保留在 AI 领域微内核，不上收到平台层：
   - provider / model runtime
   - tool calling
   - questionnaire / approval / human-in-the-loop
   - semantic event taxonomy
   - member / teammate / holon / agent identity
   - AI slash contract
   - 理由：这些能力直接依赖 AI runtime 语义，不属于跨领域平台原语。

4. **平台 capability 抽象深度选择最保守方案**：平台层只做“执行平台通用”能力，不在本轮设计完整跨领域 capability taxonomy。
   - 理由：应先稳定平台执行内核，而不是提前抽象成空泛的统一业务 capability 系统。

5. **vendor 复用作为强约束**：平台微内核必须严格建立在现有 vendor 原语之上：
   - `depa-actor` 负责 actor / fiber / mailbox runtime 原语
   - `depa-processor` 负责 manifest / variant / bundle / dispatch composition
   - `depa-data-graph` 负责 timeline / projection / state graph
   - `cell/*` 不再平行复制同类底层设施
   - 理由：现有 vendor 基础设施已经覆盖核心原语，重复造轮子会导致边界混乱。

6. **shell/runtime entry 的 P1 冻结边界**：shell 只允许依赖 assembly result 与 capability ports，shell 不再持有默认产品语义，具体 cutover 留到后续 phase 实施。
   - 理由：P1 先冻结 ownership 与消费边界，避免后续 contract/profile 设计再次回流到 shell。

### 实现要点
- 平台微内核的第一版能力清单，不包含 persistence effect ports。
- 后续 `contract` 设计需要明确区分：
  - 平台执行 contract
  - AI 领域 contract
  - app overlay contract
- 后续 `profile` 设计应保持平台基线先行，但不得要求平台层理解 AI 语义。
- 后续 `shell` 与 runtime entry 的 cutover 必须验证它们只消费装配结果与 capability ports，而不再定义默认产品语义。

### 约束与注意事项
- 不为了“未来可能复用”抽空泛抽象。
- 不把 AI 语义硬塞进平台内核。
- 不在 platform / domain 两侧维护两套 registry / profile / bootstrap 真相源。
- `depa-actor`、`depa-processor`、`depa-data-graph` 的职责归位属于强约束，而不是可选建议。
- 持久化边界需要在后续 phase 以“领域状态 + 环境实现”视角单独建模，避免在 P1 误判为平台能力。

### 参考资料
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/proposal.md`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/spec.md`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/design.md`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/plan.xml`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/analysis/platform-microkernel-feasibility-analysis.md`

## Phase P2: Contract And Package Design

### 讨论时间
2026-04-10T19:51:06Z

### 关键决策
1. **P2 必须产出三张正式边界表**：本阶段后续设计与实现必须至少形成以下三张正式表格：
   - contract ownership 表
   - runtime facet 表
   - package mapping 表
   - 理由：只有把概念边界落成结构化 ownership，后续 phase 才能稳定推进。

2. **`@cell/composer` 保留包名，但 contract 提升为平台级 composition contract**：不新建平行 composer 包，不引入新的兼容壳；直接把现有 `@cell/composer` 提升为平台级 capability composition contract。
   - 理由：当前 `@cell/composer` 已经是正式依赖入口，直接升级边界比再造过渡包更清晰。

3. **采用更激进的三分隔离思想**：后续设计与实现必须坚持以下显式隔离：
   - 数据建模 + 接口 / 副作用定义
   - 接口 / 副作用实现
   - 核心逻辑
   - 理由：这是本项目的架构原则，不应只停留在局部模块或类型层切分。

4. **`AiAgentVm` 拆分采用激进目标 ownership**：不仅拆运行时 facet，还要尽快把 AI-shaped contract 从平台边界中迁出。
   - 平台层只保留通用执行 contract
   - 明显 AI-shaped 的 contract 目标上都应迁往 AI domain contract
   - 允许实现阶段分批迁移，但目标 ownership 一次性冻结
   - 理由：如果只拆类型外形，不拆 ownership，平台边界仍会继续被 AI 语义污染。

5. **`@cell/composer` 的目标 contract 不再允许直接依赖 AI-shaped surface**：
   - `RuntimeAssemblyContext / State / Result` 目标上不再直接依赖 `AgentConfig`
   - 不再直接依赖 `ToolSchema`
   - 不再直接依赖 `actor / member / holon` 这类 AI-shaped slash surface
   - 平台 composer 只表达通用 capability composition contract
   - AI domain 再定义自己的 assembly facet / descriptor / registry contribution
   - 理由：这是平台微内核与 AI 领域微内核真正分层的核心收口点。

6. **目标包结构采用“先定目标命名，仓库暂不立即 rename”的策略**：P2 先明确 `platform-* / domain-ai-*` 方向，但当前仓库先以“现有包的新定位”推进。
   - 理由：方向需要足够明确，但 P2 不应把后续实现强行绑死到一次性 rename。

7. **兼容原则保持增量 cutover**：
   - 允许“旧包名 + 新职责”并存一段时间
   - 不要求单轮 cutover 完成全部 import path 迁移
   - shell/runtime entry 只增量切到 assembly result，不做一次性重写
   - focused tests 先验证 ownership 和行为，再验证物理包迁移
   - 理由：需要保护当前 AI runtime 连续可运行，而不是为了结构纯度引入大爆炸式重构。

### 实现要点
- P2 后续文档应显式列出：
  - 哪些 `core-contract` 导出会目标迁往 AI domain contract
  - 哪些 `core-logic` runtime state 会目标下沉为平台 facet
  - 哪些 `organ-*` 继续保留 AI domain ownership
- `composer` 的平台 contract 与 AI domain assembly facet 应拆成两层：
  - 平台组合 contract
  - AI 领域贡献 contract
- 包映射设计必须明确：
  - 现有 `core-*` 的未来平台归位
  - 现有 `organ-*` 的未来 AI 归位
  - 现有 `mod-sys-kernel` 的 AI domain baseline 定位

### 约束与注意事项
- 不能以“先兼容”为理由继续长期保留 AI-shaped composer contract。
- 不能只把 `AiAgentVm` 切成内部 type alias，而不调整 contract ownership。
- 不能把 platform contract 做成对 AI contract 的薄 re-export。
- 不能在 P2 重新引入第二套 composer/bootstrap contract 真相源。

### 参考资料
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/proposal.md`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/spec.md`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/design.md`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/plan.xml`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/context.md`
- `cell/packages/composer/src/contract.ts`
- `cell/packages/core-logic/src/runtime/runtime.ts`
- `cell/packages/core-contract/src/index.ts`
- `cell/packages/mod-sys-kernel/src/index.ts`

## Phase P3: Profile And Runtime Adoption Design

### 讨论时间
2026-04-10T19:57:23Z

### 关键决策
1. **正式 profile 链冻结为三层**：
   - `platform-only`
   - `ai-kernel`
   - `ai-coding`
   - 并要求顺序固定为：
     - `platform-only` 提供平台执行基线
     - `ai-kernel` 在其上叠加 AI 领域基线
     - `ai-coding` 在其上叠加 coding app overlay
   - 理由：平台、领域、应用三层必须有稳定的正式组合顺序，不能继续由 runtime entry 手工拼装。

2. **shell/runtime entry 的正式消费边界冻结**：
   - shell 只能消费 assembly result
   - shell 可以调用 capability ports
   - shell 不允许直接 import 某个默认 domain/app 实现来补齐能力
   - shell 可以保留纯 I/O bridge、projection bridge、session lifecycle glue
   - 理由：shell 只能是 bridge，不再是默认产品语义或默认实现的真相源。

3. **support adoption 采用 platform-support / domain-ai-support 双层分法**：
   - `platform-support` 只放纯平台环境实现，例如 profile/bootstrap config loader、generic shell resource locator、generic event log storage adapter
   - `domain-ai-support` 放 AI 领域环境实现，例如 agent/skill/provider config loader、AI runtime snapshot/transcript/history、permission config、workspace AI assets
   - 理由：support 也必须遵守平台/领域边界，不能把 AI 资源加载与 AI runtime state 支撑误放到平台层。

4. **非主 runtime 调用方也不得拥有第二真相源**：像 `TuiRuntimeCatalog` 这类非主 runtime、但需要读配置/模型目录的调用方，未来应优先通过 assembly result 暴露的 capability port/descriptor 获取能力；如果不走 runtime assembly，则必须显式退化为“无 formal capability，只做局部 fallback”。
   - 理由：不能因为它们不是主执行入口，就继续偷偷 import domain support 形成第二真相源。

5. **P3 反模式冻结**：
   - `TerminalRuntime` 不再手工拼默认 profile
   - `headless` 不再绕过正式 runtime assembly
   - `TuiRuntimeCatalog` 不再直接读取 domain support 作为隐式默认值
   - shell help / slash grammar / prompt expansion 不再保留一份 module-local static truth
   - 理由：这些都是最容易让 ownership 回流到 shell/local module 的入口，必须提前禁止。

### 实现要点
- 后续 profile 文档必须显式描述：
  - `platform-only` 暴露哪些 platform baseline capability
  - `ai-kernel` 追加哪些 domain baseline capability
  - `ai-coding` 追加哪些 app overlay capability
- shell 侧后续改造应按入口分类推进：
  - 主 runtime bridge
  - headless facade
  - tui catalog / prompt / help / slash parser
- support 归位时，凡是涉及 AI assets、AI state、AI identity、AI config 的实现，默认优先归到 `domain-ai-support`，而不是 `platform-support`。

### 约束与注意事项
- 不允许平台 profile 默认隐含 AI kernel。
- 不允许 shell 通过“临时 direct import”长期补齐 profile/assembly 缺口。
- 不允许非主 runtime 调用方因为方便而继续保留一份本地静态 grammar/help/config 真相。
- 如果某个调用方暂时无法走 formal assembly result，必须在设计上明确标记为 fallback，而不是伪装成正式 contract 消费。

### 参考资料
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/proposal.md`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/spec.md`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/design.md`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/plan.xml`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/context.md`
- `cell/packages/mod-profiles/src/index.ts`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
- `terminal/packages/tui/src/runtime/TuiRuntimeCatalog.ts`
- `terminal/packages/organ-support/src/headless.ts`

## Phase P4: Migration And Verification Plan

### 讨论时间
2026-04-10T20:02:47Z

### 关键决策
1. **迁移策略采用保守增量路线**：
   - 先文档和 contract
   - 再 profile
   - 再 shell adoption
   - 最后物理包迁移与旧路径清理
   - 理由：需要优先保证运行时连续可用，避免大爆炸式结构迁移。

2. **最优先保护的回归面冻结**：
   - 现有 AI runtime 不能失效
   - terminal / tui / headless 入口不能中断
   - 默认 profile 行为不能悄悄漂移
   - shell slash / help / prompt expansion 不能出现第二真相源回流
   - 理由：这些入口和默认行为是当前用户可感知的正式主链。

3. **第一批实施波次固定为四波**：
   - Wave 1：定义 platform contract / composer contract / ownership tables
   - Wave 2：引入 `platform-only` profile，并让现有 profile 显式叠加
   - Wave 3：cutover shell/runtime entry 到 assembly result / capability ports
   - Wave 4：执行物理包迁移和旧路径清理
   - 理由：先冻结 contract 真相源，再调整 profile，再迁入口，最后清理物理结构，风险最低。

4. **focused verification baseline 固定为四类**：
   - ownership tests
   - profile order tests
   - capability absence tests
   - runtime adoption tests
   - 理由：微内核升级的风险在 ownership、组合顺序、缺失语义和正式 adoption，而不是单纯文件移动。

5. **迁移红线冻结**：
   - 不一次性 rename 全仓包路径
   - 不边迁移边再引入新的临时默认真相源
   - 不用 shell/runtime entry 临时硬编码补齐 contract 缺口
   - 不把 focused tests 写成源码 grep
   - 理由：这些做法会让设计边界立刻失真，并增加不可控回归。

6. **每一波都必须保持当前 AI runtime 连续可运行**：
   - 每一波结束时，至少 terminal / tui / headless 主路径仍可运行
   - 不允许先打断入口，再寄希望下一波修复
   - 理由：这是本 track 的核心交付约束，保证迁移过程对现有运行时无硬中断。

7. **本 track 的完成条件冻结为“设计基线完成”**：
   - proposal / spec / design / plan / context 足够支撑后续实现 track
   - ownership / profile / adoption / migration baseline 已明确
   - 本 track 不要求自己完成代码 cutover
   - 理由：本 track 的职责是形成正式架构实施基线，而不是直接承载所有实现工作。

### 实现要点
- 后续实现 track 应按四波顺序拆分，而不是自由穿插：
  - contract/ownership
  - profile layering
  - shell adoption
  - package cleanup
- 每一波都需要定义最小可运行验收：
  - terminal 可启动并进入主 runtime
  - tui 可消费正式 runtime assembly
  - headless 不绕过正式 assembly
- focused verification 应优先写行为断言和 ownership 断言，而不是 grep 某个文件里是否还存在某个 import。

### 约束与注意事项
- 任何一波都不能用“临时硬编码”作为长期过渡方案。
- 如果某一波无法保证 terminal/tui/headless 连续可运行，则该波的设计需要重新拆分。
- 本 track 完成后，应以新的实现 track 承接波次，而不是继续在当前设计 track 中混写实现细节。

### 参考资料
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/proposal.md`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/spec.md`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/design.md`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/plan.xml`
- `codument/tracks/refactor-platform-kernel-and-ai-domain-kernel/context.md`
