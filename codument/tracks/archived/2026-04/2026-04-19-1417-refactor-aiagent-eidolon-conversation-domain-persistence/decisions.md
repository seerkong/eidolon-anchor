# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 本次 track 的必做项已经固定为：消息历史、压缩、历史 session 加载、`.eidolon` 本地持久化
- 下面的问题只用于决定哪些“当前尚无完整宿主机制”的部分先做定义，哪些同步做第一版 runtime 落地

### 1. 【P0】Rollback / Fork 的落地深度
- 背景：
  - 参考设计把 rollback / fork 建模为 history generation/head/lineage 的正式操作
  - 本项目当前已有 session 恢复与历史加载，但没有正式 rollback / fork runtime surface
- 需要决定：
  - 本次是否把 rollback / fork 做到可调用 runtime API
- 选项：
  - A. 只定义 contract、事件、持久化槽位，不实现 runtime API
    - 影响：本次先完成历史、压缩、历史 session 加载；rollback / fork 后续再接
  - B. 实现 internal runtime API 与 reducer 语义，但不开放 slash/TUI surface
    - 影响：后续 UI 接入更容易，但本次工程范围更大
  - C. 直接连到 slash/TUI session surface
    - 影响：范围最大，会把 UI/交互一起拉进当前 track
- 当前建议：
  - A（推荐）
- 最终结论：
  - A. 只定义 contract、事件、持久化槽位，不实现 runtime API
- 理由：
  - 当前用户明确要求的是消息历史、压缩、历史 session 加载；rollback / fork 还不是阻塞项
  - 先把 lineage 与 storage slot 定义清楚，后续再接 runtime surface 更稳妥

### 2. 【P0】Prompt Context Asset 的首版范围
- 背景：
  - 参考设计希望把 MCP/resource/workspace file/upload 等上下文统一到 prompt domain
  - 本项目当前没有完整的 conversation asset registry
- 需要决定：
  - 本次对 context asset 做到什么深度
- 选项：
  - A. 只定义 asset registry contract 与 transform kinds，不接正式 runtime
    - 影响：本次聚焦 history/compaction/session load
  - B. 先接已有宿主机制：workspace file / MCP resource 的 registry 与 attach transform
    - 影响：能让 prompt domain 有第一批真实资产，但不引入上传/片段选择等更大表面
  - C. 连 future upload / extract / select / summary bind 一起做
    - 影响：需要额外产品和交互机制，范围显著扩大
- 当前建议：
  - B（推荐）
- 最终结论：
  - A. 只定义 asset registry contract 与 transform kinds，不接正式 runtime
- 理由：
  - 当前主目标是收敛 `.eidolon` 的消息历史、压缩与历史 session 加载
  - context asset 本轮先定义正式数据位点，避免扩散到额外 runtime 与交互范围

### 3. 【P1】Micro Compact 是否进入本次 runtime 落地
- 背景：
  - 用户已明确要求“压缩”必须落地
  - 这里的“压缩”至少包含当前已有的 session compact / state snapshot 历史压缩
  - 但参考设计还区分了 micro compact 这类 prompt-only transform
- 需要决定：
  - 本次是否同步实现 micro compact
- 选项：
  - A. 只完成正式 history compaction + prompt head 切分，不实现 micro compact
    - 影响：先把当前 `/compact` 正规化
  - B. 同步实现 micro compact 的 prompt transform，但不开放新交互 surface
    - 影响：prompt domain 更完整，但需要补更多 reducer / tests
  - C. 连 micro compact 的 runtime 和交互表面一起做
    - 影响：范围最大
- 当前建议：
  - A（推荐）
- 最终结论：
  - A. 只完成正式 history compaction + prompt head 切分，不实现 micro compact
- 理由：
  - 当前最需要迁移的是已有 compaction 主链，而不是新增一套更细粒度 compact 机制

### 4. 【P1】Branch / Explain 的消费面范围
- 背景：
  - reference 设计包含 branch 可回看与 diagnostic explain view
  - 本项目当前更急的是 persistence 与 recovery 主链
- 需要决定：
  - 本次是否同步做 branch 浏览或 explain surface
- 选项：
  - A. 只提供 query contract / debug helper，不做正式 UI/TUI surface
    - 影响：先把底层真相立起来
  - B. 增加 headless/debug surface，但不改 TUI 主界面
    - 影响：可调试性更强，UI 改动仍受控
  - C. 直接做 TUI/Web 正式 branch / explain surface
    - 影响：范围显著扩大
- 当前建议：
  - A（推荐）
- 最终结论：
  - A. 只提供 query contract / debug helper，不做正式 UI/TUI surface
- 理由：
  - branch / explain 依赖底层 head/lineage 先稳定，先做消费面会放大不确定性
