# 变更：物化唯一 Effective Eidolon VFS

## 背景和动机 (Context And Why)

Builtin snapshot、home `.eidolon`、workspace `.eidolon` 目前还没有一个宿主级事务把它们收敛成唯一的运行时文件 authority。旧 `ResourceVFSLoaderOps.fromEidolonRoots` 只读取少数配置并直接 later-wins merge，无法表达 replacement 撤销回退、显式删除、稳定 move/rename、XNL mutation、revision fence 或失败保持上一 admitted revision。

## "要做"和"不做" (Goals / Non-Goals)

目标：

- 把物理 home/workspace `.eidolon` 递归投影为带稳定路径 identity 的 sparse directory overlay intent；
- 以 immutable Builtin snapshot 为每次重算的 base，按 home → workspace 与显式 mutation的声明顺序形成完整 candidate；
- 在 candidate 上运行全部 validator，再通过 XNL revisioned CAS 原子发布并生成宿主 plan/receipt/read port；
- 拒绝 stale revision、identity/precondition、symlink/path、validator 与持久化失败，且不改变上一 admitted revision；
- 从 admitted read port 生成只读 legacy `ResourceVfs` projection。

非目标：

- 本 Track 不把 Halfcode registry consumer 切换到 Effective VFS（G5）；
- 不迁移 Agent authoring 的 durable write（G5）；
- 不让 `symbiont-logic` 知道 BunFS 或 `mod-ai-coding`，Builtin snapshot 由 composition 注入；
- 不设计 Kubernetes Server-Side Apply field manager。

## 变更内容（What Changes）

- 在 `symbiont-logic` 增加 physical overlay source projector、Effective VFS materializer/authority、validator port、revision-bound read port 与 legacy projection。
- 增加 `xnl-core` / `xnl-vfs` 运行依赖并复用公开 overlay/CAS API。
- 用 product tests 固定 replacement/no-opinion/delete、stable identity、XNL mutation、validator/CAS rejection 与 immutable read semantics。

## 影响范围（Impact）

- 受影响能力：`eidolon-resource-native-app-registry`
- 受影响代码：`cell/packages/symbiont-logic`、`cell/packages/symbiont-contract`（仅在现有 contract 缺字段时最小修订）
