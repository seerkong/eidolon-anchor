# 设计：Runtime Profile Capability Boundary

## 上下文

系统演进目标是双层微内核：Platform Kernel 提供通用执行、组合、调度、持久化端口、诊断、权限、profile/capability 等机制；AI Domain Kernel 提供 provider/tool/conversation/member/holon 等 AI 语义。

Product Surface 包括 TUI、CLI、headless harness。它们不应分别拼默认 runtime，而应通过同一个 profile composition path 进入 runtime。

## 方案概览

### 1. Profile Contract

Profile 表达产品组合：

- platform baseline。
- AI domain kernel。
- app overlay，例如 coding。
- surface capability，例如 TUI/CLI/headless。
- storage capability：`logs`、`files`。

### 2. Capability Registry

Capability registry 表达可插拔能力：

- provider/model capability。
- tool capability。
- persistence capability。
- upgrade capability。
- surface input/output capability。
- work context capability。

### 3. Runtime Binding Descriptor

Runtime binding descriptor 是可测试输出：

- selected profile id。
- enabled capabilities。
- storage flags。
- entry type。
- domain kernel modules。
- app overlays。
- surface capabilities。

CLI/TUI/headless 对同一 profile 应生成兼容 descriptor。

### 4. Entry 规则

- Entry 可以选择 profile。
- Entry 可以提供 surface IO adapter。
- Entry 不可以定义 provider/tool/conversation 默认语义。
- Entry 不可以绕过 profile 直接打开 session persistence 或 domain truth writer。

### 5. Tests

- profile descriptor snapshot tests。
- CLI/TUI/headless descriptor consistency tests。
- storage flags off smoke tests。
- surface no-domain-write tests。

## 决策摘要

- 该 track 是扩展面边界，不迁移数据 owner。
- 与 DataSubgraphContract track 可串行推进；推荐 DataSubgraphContract 先行。
- storage `logs/files` 是 runtime capability，不应硬编码在 TUI/CLI entry。
- TUI upgrade prompt 应调用共享 upgrade capability，不引入私有迁移语义。
- 宿主包：profile/capability contract 与组合实现优先收敛到现有 `mod-profiles` 与 `ai-composer` 组合路径，必要时在其上扩展；禁止新建与之平行的第二个 profile/capability registry 真相源。
- 实施第一步应先盘点 `mod-profiles`/`ai-composer` 现有结构是否足以承载 binding descriptor，盘点结论记入 analysis 后再动 terminal entry。

## 风险 / 权衡

- 风险：composition path 收敛会触碰多个 terminal packages。
  - 缓解：先引入 binding descriptor tests，再逐步迁移入口。
- 风险：profile contract 过度抽象。
  - 缓解：只覆盖已有 CLI/TUI/headless 与 storage flags，不为未知产品预留复杂机制。
- 风险：与现有 work-context/session-upgrade tracks 重叠。
  - 缓解：现有成果作为 capability 输入，不重复实现内部语义。
