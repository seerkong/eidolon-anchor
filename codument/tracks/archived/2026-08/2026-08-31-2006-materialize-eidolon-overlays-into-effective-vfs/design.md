# Design：materialize-eidolon-overlays-into-effective-vfs

## 1. Owner boundary

`symbiont-logic` 拥有 storage-neutral 的 Eidolon overlay materialization。它接收已反序列化的 immutable Builtin XNL VFS snapshot，不导入 `mod-ai-coding`，也不识别 BunFS。物理 source adapter 只把 `.eidolon` 目录变成 intent；consumer 只拿 revision-bound read port。

```text
Builtin DataElement snapshot (injected)
  + home directory snapshot / mutations
  + workspace directory snapshot / mutations
        │ plan from immutable Builtin every time
        ▼
complete candidate ─ validators ─ XNL revisioned CAS
        │ reject                   │ admit
        ▼                          ▼
last admitted unchanged     EffectiveVfsRecord@sha256 revision
                                  ├─ read port
                                  └─ read-only legacy projection
```

## 2. Rebuild, not incremental layer residue

每次 materialize 都从 immutable Builtin base 重新应用当前 overlay intent。因此删除一个 replacement 文件表示该 overlay 不再对路径发表意见，结果自然回退 Builtin；只有显式 `FILE_DELETE` 才从 candidate 删除文件。发布阶段再计算 `current admitted → candidate` 的 mutation batch，并以当前 XNL authority revision做 CAS。

## 3. Physical overlay projection

- 逻辑根固定为 `/.eidolon`，递归读取所有普通文件；不存在的物理根产生空 sparse overlay。
- symlink、特殊文件、路径逃逸和无效 UTF-8 XNL 拒绝；非 UTF-8 普通文件以 binary/base64 表示。
- node id 由 overlay id + node kind + logical path 的 sha256 派生，不依赖内容或进程随机数；同路径 replacement 在 merge 时保留 base node id。
- source snapshot/digest 只是 user intent evidence，不是 runtime authority。

## 4. Materialization transaction

1. 检查 caller 的 `expectedCurrentRevision` 是否等于当前 admitted revision。
2. 使用 XNL `planVfsOverlays` 在 Builtin clone 上按连续 order 规划全部 directory/mutation intent。
3. 计算 candidate canonical snapshot digest 和宿主 `EidolonVfsMaterializationPlan`。
4. 所有 validator 读取隔离 candidate read port；任一 diagnostic 产生 rejected receipt，CAS 不执行。
5. 计算 current → candidate strict VFS/XNL mutation，调用 `publishRevisionedVfsOverlayPlan`；stale CAS/failure映射为 rejected receipt。
6. 只有 CAS applied/unchanged 且 readback digest精确匹配 candidate 时，替换当前 immutable Effective record。

Validator 是 effect port，G4 提供结构/root validator；G5 可以注入 Halfcode closure validator。这样 G4 不反向依赖 Halfcode，但 duplicate FQN/invalid resource 可以在同一个 publish gate 内 fail closed。

## 5. Revision and receipts

- XNL authority revision是内部 CAS token；宿主 effective revision是 canonical full snapshot bytes 的 sha256 digest。
- `baseRevision` 来自 Builtin snapshot bytes digest；overlay descriptor digest 来自 directory snapshot 或 mutation payload 的 canonical bytes。
- admitted receipt绑定 previous/published revision、candidate digest和 validator evidence；rejected receipt声明保持的 current revision。
- read port永久绑定一个 admitted snapshot和克隆后的 VFS bytes，不 live reread physical overlay。

## 6. Compatibility projection

Legacy `ResourceVfs` 从一个 Effective read port 全树遍历生成，只包含 UTF-8 text/xnl 文件并标记 source revision。它通过既有 `createLegacyResourceVfsProjection` 冻结，禁止 merge/write 回 authority；binary 文件不伪装成文本。

## 7. Impact and verification

- 新增 `cell/packages/symbiont-logic/src/resource/EffectiveEidolonVfsMaterializer.ts`
- 新增对应 product tests；修改 package dependencies/root export。
- 验证 replacement撤销、explicit delete、home/workspace precedence、stable IDs、move/rename、XNL precondition、validator rejection、stale concurrent CAS、immutable bytes与 legacy projection。

## 8. Migration boundary

G4保留旧 loader API，但不扩展它。G5将 Terminal/Registry consumers改为构造这个 authority并只读 Effective port；G5完成前旧 loader仍是待迁移入口，不被本 Track宣称已经切换。
