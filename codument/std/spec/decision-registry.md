# Decision Registry 规范

`codument/decisions/` 是长期承重决策的 canonical XNL registry。它保存 track / mission decision forest 中符合晋升条件的完整节点，而不是从节点投影出的 Markdown 摘要。

## 1. Canonical 物理形态

```text
codument/decisions/
  <owner-or-topic>.xnl
  <owner-or-topic>/
    index.xnl
    <subtopic>.xnl
```

- registry 同时包含根级 `codument/decisions/*.xnl` 与递归 `codument/decisions/**/*.xnl`；所有文件共同组成一个逻辑 registry。
- 物理 owner file、目录层级和文件名只负责分片与维护，不参与 decision identity。
- 新 durable decision 必须以完整 XNL AST 持久化。`decision.md`、`summary.md` 或其他 Markdown 只能是历史兼容输入、迁移来源或派生视图，不能参与 canonical merge、stable-id index 或 URI resolution。
- archive 中的原始 decision sources 保留为 provenance；派生 summary 不反向覆盖 registry。

## 2. Source set 与晋升资格

track 和 mission 的 decision source set 由以下来源同时组成：

1. 根 `decisions.xnl`；
2. 递归 `decisions/**/*.xnl`。

任何一类存在都不得压制另一类。旧 `decisions.md`、`decisions/**/*.md` 仅在显式 legacy compatibility 或 migration 流程中读取，不作为新 source 的 authoring 格式。

只有 `durable_candidate = true` 且 `status = "accepted"|"resolved"` 的 decision 才晋升。若 durable decision 位于嵌套 tree 中，必须保留解释它所需的 top-level tree closure、ancestor/provenance 与关联节点；不得把 tree 展平为彼此无关的 records。

## 3. Full-fidelity 规则

archive、migration、serializer 和 merge 直接操作 XNL AST，不得通过摘要 DTO 重建节点。至少保留：

- 稳定 `#id`、tag、attributes、metadata 与未知扩展字段；
- `question`、`recommendation`、`options` / `option`；
- `answer`、`raw-answer`、`decision-text`、`rationale`、`evidence`；
- `depends_on`、`activation`、`derived_from`；
- nested decision hierarchy；
- source / provenance。

## 4. Identity、index 与 URI

- decision identity 只由稳定 XNL `#id` 决定。
- canonical URI 为 `decision://<id>`；URI 不包含 archive 时间戳、bucket、owner file 或物理目录。
- resolver 必须递归加载整个 registry，建立全局 stable-id index，再按 id 定位 owner file 和 ancestor path。
- duplicate stable id、syntax error 或其他 registry issue 必须 fail closed；不得按文件顺序任取一个候选。
- summary 和 legacy Markdown 不进入 index，因此不能仅凭其中出现 `Decision URI:` 就解析为 canonical decision。

## 5. Merge 与 owner policy

- 新 id：加入 registry。
- 相同 id 且完整 AST 语义等价：幂等，不产生重复节点。
- 相同 id 且不等价：在没有可信 base 时保守报告 conflict，不静默覆盖。
- 同一 decision tree 默认保持在同一 owner file；已存在 id 保持原 owner。
- 来自递归 `decisions/**/*.xnl` 的新 tree 保留其相对业务 owner path。
- track / mission 根 `decisions.xnl` 只承载过程决策；其中出现待晋升 durable tree 时，因为缺少业务 owner，archive 与 migration 必须返回 AI review，不得猜测路径或回退到 `registry.xnl`。
- owner path 必须表达业务或知识归属，不得使用日期 bucket、archive id 或 track id 代替业务分类。
- owner file 可以演化，但 stable id、URI、tree hierarchy 和节点语义必须保持稳定。

## 6. Archive transaction

decision registry 与 behavior、modeling、engineering registries 共享：

```text
collect all deltas and decision sources
  -> parse and build indexes
  -> merge and detect conflicts
  -> validate every staged registry
  -> stage all registry trees
  -> rollback-capable commit
  -> move track / mission
  -> generate derived summary/provenance view
```

任一 decision parse、duplicate-id、merge、reference validation 或 registry replacement 失败时，live registries 必须恢复到调用前状态，track / mission 不移动。移动完成后生成的 summary 是派生视图，不参与上述 transaction 的 registry merge/index。

## 7. Validation 与 legacy migration

`codument decisions validate` 对目录执行递归 XNL registry validation；对 track / mission id 同时验证根 `decisions.xnl` 和递归 `decisions/**/*.xnl`。校验至少覆盖 syntax、stable/duplicate id、hierarchy、dependency/activation/derived_from reference，并报告 file、decision id、layer/reason。

显式传入历史 Markdown 文件时可执行 legacy validation。历史 registry 升级统一运行 `codument upgrade-resource <path> --json`；CLI 负责 inventory、backup、staging、verify 与 rollback。返回 `review-required` 时，AI 才按 Decision 规范补齐业务 owner、保真语义、provenance 与 ambiguity，再重跑同一命令。详见 `std/operations/migrate.md`。
