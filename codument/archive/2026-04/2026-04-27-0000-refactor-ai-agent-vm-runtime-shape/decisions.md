# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】是否保留 aiFacet 作为兼容字段
- 背景：现有 `AiAgentVm` 通过 `aiFacet` 与 `sessionState/runtimeContext` getter/setter 维持兼容。
- 需要决定：第一阶段是否保留 `aiFacet`。
- 选项：
  - A) 保留 `aiFacet`，标记为兼容 facade，内部与标准字段同源
  - B) 立即移除 `aiFacet`，同步修改所有调用点
  - C) 其他（可填写）
- 当前建议：A，但长期主结构改为 `holonRuntime`
- 用户答复：希望将原 `aiFacet/sessionState/runtimeContext` 按一级分类方法归入 `AiHolonRuntime`
- 最终决策：保留旧 helper/兼容 facade，但 `AiAgentVm` 标准主结构以 `holonRuntime` 为准
- 决策理由：降低现有调用点迁移风险，同时避免旧 AI facet 继续作为长期主模型
- 状态：accepted

### 2. 【P0】标准字段类别命名
- 背景：需要避免复制参考项目 controller runtime 的大杂烩问题。
- 需要决定：字段类别按什么粒度表达。
- 选项：
  - A) `platform / ai / rx / observability` 四类
  - B) `system / domain / protocol / observability` 四类
  - C) 其他（可填写）
- 当前建议：按用户给出的一级分类：actors、holonRuntime、runtime knobs、non-rx data、rx data
- 用户答复：希望进一步改造为 actors、holonRuntime、options/effects/callbacks、outerCtx/innerCtx/snapshots、rx data 结构
- 最终决策：采用用户指定的一级分类，并在 ownership 中显式表达
- 决策理由：该分类比原 `platform / ai / rx / observability` 更贴近本项目双层微内核与多 AI 协作边界
- 状态：accepted

### 3. 【P0】innerCtx 承载范围
- 背景：用户希望新增 `innerCtx`，存放原 `registries`、`mcpManager`、`recovery`。
- 需要决定：第一阶段 innerCtx 的字段范围。
- 选项：
  - A) 仅迁移 `registries`、`mcpManager`、`recovery`
  - B) 同时迁移 `options/effects/callbacks`
  - C) 其他（可填写）
- 当前建议：A；`options/effects/callbacks` 按用户草案保留为顶层 runtime knobs
- 用户答复：希望 `innerCtx` 存放原 `registries`、`mcpManager`、`recovery`
- 最终决策：采用 A
- 决策理由：与用户草案一致，且避免 innerCtx 重新变成大杂烩
- 状态：accepted

### 4. 【P1】snapshot 类型命名与边界
- 背景：用户草案中 `immutableSnapshot` 与 `mutableSnapshot` 都写作 `AiRuntimeImmutableSnapshot`，但语义上 mutableSnapshot 应有独立类型。
- 需要决定：类型命名和首批内容。
- 选项：
  - A) `immutableSnapshot: AiRuntimeImmutableSnapshot`，`mutableSnapshot: AiRuntimeMutableSnapshot`
  - B) 二者都使用 `AiRuntimeSnapshot`，通过字段说明可变性
  - C) 保持草案中二者都为 `AiRuntimeImmutableSnapshot`
- 当前建议：A
- 用户答复：确认按照建议，`immutableSnapshot: AiRuntimeImmutableSnapshot`，`mutableSnapshot: AiRuntimeMutableSnapshot`；并允许二者根据现状按类别继续扩充添加。
- 最终决策：采用 A，且 snapshots 作为按生命周期分类的可扩展类别容器。
- 决策理由：不可变快照与可变快照生命周期不同，独立类型能防止可变状态误入 immutable snapshot；按类别扩充能适配当前代码现状。
- 状态：accepted

### 5. 【P1】private rx binding 字段拼写
- 背景：用户草案写作 `privateRxDBinding`，但与 `publicRxBinding` 对称的命名应为 `privateRxBinding`。
- 需要决定：是否规范拼写。
- 选项：
  - A) 使用 `privateRxBinding`，不引入拼写遗留
  - B) 保留 `privateRxDBinding`
  - C) 提供 `privateRxDBinding` deprecated alias
- 当前建议：A；如已有外部调用再考虑 C
- 用户答复：确认 `privateRxDBinding` 是拼写问题，规范为 `privateRxBinding`
- 最终决策：采用 A，字段统一命名为 `privateRxBinding`
- 决策理由：与 `publicRxBinding` 对称，避免拼写型 API 遗留。
- 状态：accepted

### 6. 【P1】innerCtx 可扩展边界
- 背景：用户指出 `innerCtx` 需要根据现状情况继续按类别扩充添加。
- 需要决定：扩充原则。
- 选项：
  - A) `innerCtx` 是内部上下文类别容器，可按类别扩充，但每个新增字段必须说明生命周期与职责
  - B) `innerCtx` 仅固定包含 `registries/mcpManager/recovery`
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：希望根据现状情况按类别继续扩充添加
- 最终决策：采用 A
- 决策理由：当前代码迁移需要保留弹性，但必须用类别边界避免 `innerCtx` 退化为 controller-runtime 大杂烩。
- 状态：accepted
