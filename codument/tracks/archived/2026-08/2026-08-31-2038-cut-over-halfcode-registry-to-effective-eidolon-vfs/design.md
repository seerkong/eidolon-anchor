# Design：Effective VFS → Halfcode Registry 单向投影

## 上下文

G4 已提供 `EffectiveEidolonVfsMaterializer` 与不可变 `EidolonVfsReadPort`。Halfcode 已支持 storage-neutral `loadResourceTreeFromReadPort`。本 Track 不新建资源系统，而是把现有 registry、source capture、freeze/recovery 全部映射到这两条成熟链路。

## 原逻辑到 Halfcode/VFS 架构的映射

| 原逻辑 | 代码位置 | 新映射 |
|---|---|---|
| global/workspace 各自 `loadResourceTree(rootDir)` | `EidolonAppResourceRegistryAdapter.loadSnapshot` | 对一个 admitted read port 的 `/.eidolon/resources` 调用 `loadResourceTreeFromReadPort` |
| `composeLayeredResourceRegistry(global, workspace)` | 同上 | 只组合一个 `effective-vfs` semantic layer；重复 FQN 由单树校验拒绝 |
| source/profile dependency 使用 `realpath/readFile` | `readEffectiveSource`、`loadEffectiveProfile` 等 | 按 registry logical path 映射到 VFS package root，由 snapshot-bound port 读 bytes |
| KindDefinition authority digest 回读 layer 文件 | `readKindDefinitionAuthorityDigests` | 从相同 VFS read port 读取 `documentUri` 对应 bytes |
| freeze 分别复制 `.agent-resources/global|workspace` | `captureFrozenResourceClosure` | 保存 `.agent-resources/effective-vfs/**` 与 revision/provenance manifest |
| recovery 再组合 frozen global/workspace | `WorkflowRuntimeService.frozenAgentRegistry` | 从 frozen effective closure建一个不可变 read port，再投影同一 registry |

## 方案概览

1. 定义 `EffectiveEidolonVfsRegistrySource`，包含 read port 与 package root；兼容扩展现有 snapshot，明确携带 `effectiveVfsRevision/treeDigest/materializationReceiptId`。
2. 用 path adapter 把 `EidolonVfsReadPort` 映射为 Halfcode `ResourcePackageReadPort`，只允许 `/.eidolon/resources` 子树。
3. adapter 每次 refresh 捕获一个新的 read port；已产生的 source owner 继续关联旧 snapshot/read port，不依赖 live current pointer。
4. 完整 tree、Kind、content identity 与 Holon projections 全部成功后才 admit registry snapshot。
5. closure capture 递归读取 VFS，保存 deterministic text files 与 provenance manifest；binary resource fail closed，避免 string closure 静默损坏。
6. production runtime 在 component 构造前 materialize Builtin + home + workspace，注入 resulting read port。现有 physical layer authoring bridge 保持显式隔离，等待 G5-T2 迁移。

## 事务与冻结

```text
Effective VFS revision E
  -> Halfcode tree from read port
  -> content identities + projections
  -> registry snapshot R(E)
  -> exact source/dependency reads from E
  -> frozen closure F(E, R)
```

刷新到 E2 不修改 E1 的 read port，也不改变已经 frozen 的 Agent/Workflow closure。provider-visible Agent prefix 只在新 run 或显式 resource epoch 选择 E2 时变化。

## 兼容性设计

- snapshot v1 冻结目录仍可由 legacy recovery reader读取；新运行只写 effective-vfs closure。
- `loadIsolatedSnapshot({layers})` 在 G5-T2 前可作为 authoring candidate bridge，但其结果必须先 materialize 为一个 isolated VFS port，再走同一 projection；不允许直接 compose layered registry。
- `contentIdentityLayers` 保留，内容变为唯一 `effective-vfs` tree，保证当前 Holon proof 不丢能力。

## 风险 / 权衡

- 大量测试直接构造 layer binding：先新增 test fixture materializer，迁移关键 product tests；compat bridge 仅用于未迁移 authoring tests。
- profile loader 当前是同步 callback：VFS dependency bytes需在调用前按 declared closure预取，或提供同步 frozen map；禁止回退 node:fs。
- 并行 Mission 正在修改 provider/Holon 区域：只修改 registry/resource wiring 的精确区段，并保留 `contentIdentityLayers` 变更。

## 迁移计划

1. RED tests 固定 single-revision tree、no physical reread、duplicate fail-closed 与 frozen recovery。
2. 实现 read-port projection、snapshot/source/dependency/freeze。
3. 切 production component/terminal binding；保留 isolated authoring bridge。
4. 运行 registry、Agent/Workflow/Holon 与 recovery 回归；后续 G5-T2 删除 authoring physical write authority。

## 待解决问题

- 无待人工决策；legacy bridge 的最终删除已由后续 Track 承担。
