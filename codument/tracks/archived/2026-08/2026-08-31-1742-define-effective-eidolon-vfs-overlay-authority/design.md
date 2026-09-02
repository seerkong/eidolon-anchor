# Design：Effective Eidolon VFS overlay authority

## 上下文

当前 `cell/packages/symbiont-contract/src/resource/ResourceVFS.ts` 只表示 `path -> text`，`ResourceVFSOps.merge` 采用 later-wins；`ResourceVFSLoaderOps.fromEidolonRoots` 直接把物理根合成最终 map。另一方面，`EidolonAppResourceRegistryAdapter` 仍以 physical `rootDir` 加载 Halfcode ResourceTree，再组合 global/workspace layers。两条链路分别拥有“最终态”，会造成 authority 分叉。

目标不是另起一套 Agent/Resource loader，而是把现有 Eidolon 处理链路完整映射为 Halfcode 可消费的 VFS 架构：overlay 只在 materializer 内出现；所有 runtime consumer 只看到一个不可变、带 revision 的 Effective VFS。

## 方案概览

### 1. Authority pipeline

```text
Builtin snapshot B
  + ordered overlay intent [home, workspace]
  + expected admitted revision fence
        │
        ▼
materialization plan P
        │ dry-run / identity + precondition / complete validation
        ▼
candidate C ──reject──> rejection receipt (current revision unchanged)
        │ atomic publish
        ▼
Effective Eidolon VFS E
        │
        ├── legacy ResourceVfs text projection
        ├── runtime config read port
        └── Halfcode read port → semantic registry → Agent/Workflow freeze
```

只有 admitted Effective snapshot 是运行时文件 authority。Builtin、home/workspace physical tree、plan、candidate、Halfcode registry 都不能被 consumer 当作第二可写/可读最终态。

### 2. 宿主 contract

宿主 contract 使用 JSON-safe / storage-neutral 数据，不依赖 XNL runtime 的具体类：

- `EffectiveEidolonVfsSnapshot`：schema version、VFS revision、base revision、ordered overlay refs、root path、tree digest、admitted timestamp。
- `EidolonVfsReadPort`：按逻辑路径 `stat/list/readBytes`，且暴露所绑定的 snapshot；实现不得 live reread overlay。
- `EidolonVfsOverlayDescriptor`：只记录 overlay id、kind、order、intent revision/digest；mutation payload 由 XNL owner 定义并在 plan 中以 opaque digest/receipt 关联。
- `EidolonVfsMaterializationPlan`：expected current revision、base revision、ordered overlays 与 candidate digest。
- `EidolonVfsMaterializationReceipt`：admitted/rejected discriminated union。admitted 必须绑定 previous/current revision、candidate digest 和 validation proof；rejected 必须绑定 current revision、失败 diagnostics，且不能声明 published revision。

本 Track 的 guard 只验证跨组件不变量，不实现 diff/apply。XNL Track 可用自己的强类型对象执行 materialization，再投影为这些宿主 receipts。

### 3. Identity 映射

| Identity | Authority | 用途 |
|---|---|---|
| `/.eidolon/**` path | Effective VFS | overlay 位置与 consumer 寻址 |
| VFS node id / `expectedId` | XNL VFS | rename/move、重放与基线校验 |
| XNL element `#id` | XNL document | 文件内 mutation 对齐 |
| Halfcode FQN | final ResourceTree | 最终领域身份、引用、重复检测 |

FQN 只在物化后产生语义投影。同一最终 VFS 中的重复 FQN 必须由 Halfcode fail closed；不得通过“workspace layer wins”隐藏冲突。

### 4. Legacy compatibility

`ResourceVfs` 在迁移期保留，但明确降级为 `EffectiveEidolonVfsSnapshot` 的只读 text projection。旧 API 可继续给 RuntimeConfig 使用，直到 consumer Track 切换；任何 loader 都不能再把 home/workspace 直接 merge 后宣称是 admitted Effective VFS。

旧 registry/freeze receipt 的 `layer` 和 `registryRevision` 可继续读取；新写入必须增加 Effective VFS revision、materialization receipt id 和 resource content closure。运行中的 Agent/Workflow 绑定精确 revision；live overlay 变化只影响新 run 或显式 resource epoch。

### 5. RED acceptance inventory

本 Track 的 executable tests 先固定 contract shape/guard。后续 Track 必须逐项把 `reports/authority-baseline.md` 中的系统级 RED 场景转为对应 owner 的实现测试，包括 replacement 撤销回退、explicit delete、stable rename/move、XNL stale precondition、atomic rejection、B1→B2 replay、duplicate FQN、freeze recovery 和 provider prefix stability。

## 影响范围与修改点（Impact）

- 新增：`symbiont-contract/resource/EffectiveEidolonVFS.ts`
- 新增：`symbiont-logic/resource/EffectiveEidolonVFS.ts`
- 修改：两个包的 root export
- 新增：`symbiont-logic/tests/effective_eidolon_vfs_contract.test.ts`
- 行为变更通过当前 Track 的 BehaviorPatch 表达，不直接编辑共享 behavior authority。

## 决策摘要

- overlay authority 位于 VFS materialization 层，不位于 Halfcode FQN registry 层。
- Builtin snapshot 是 immutable input；Effective snapshot 是唯一 runtime read authority。
- 本 Track 固定 storage-neutral host contract；XNL/halfcode 实现细节由各自 owner Track 决定。
- `ResourceVfs` 仅作为兼容 projection 存活，禁止继续扩展为第二 authority。

## 风险 / 权衡

- contract 过早绑定 XNL 实现细节 → 只保留跨组件 identity、revision、digest 与 receipt，mutation payload 保持 owner-defined。
- 并行 resource-authoring Mission 正在改 registry → 本 Track 不编辑 registry 实现或共享 behavior 文件，只提供新 contract/delta。
- 迁移期双链路被误用 → contract 和行为明确区分 overlay input、candidate、admitted snapshot、semantic projection。

## 兼容性设计

- 保留现有 `ResourceVfs` 类型与 API；后续以显式 adapter 从 Effective read port 生成。
- receipt 采用新 schema version；旧 snapshot reader 不被本 Track 删除。
- 物理 `.eidolon` 继续是 durable user intent 的写入位置，但不再是 runtime read authority。

## 迁移计划

1. 本 Track冻结宿主 contract 与行为。
2. XNL 提供稳定 snapshot/overlay materializer；Halfcode compiler 提供 read port。
3. 宿主嵌入 Builtin Coding Agent，并物化 home/workspace overlays。
4. registry/authoring/freeze consumers 切到 Effective VFS。
5. E2E 证明 source/compiled、升级、三种运行模式与 prefix stability。

## 待解决问题

- XNL owner Track 决定 canonical mutation serialization 的具体 Kind/FQN，但不得改变这里的 authority topology。
- Halfcode owner Track 决定 read port 的最小方法集，但必须证明 directory/VFS parity。
