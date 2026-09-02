# 变更：定义 Effective Eidolon VFS overlay authority

## 背景和动机 (Context And Why)

Eidolon 当前存在两条互相竞争的资源链路：`ResourceVfs` 把 home/workspace `.eidolon` 直接合并为无 revision 的文本 map；Halfcode registry 则直接读取 global/workspace 物理 ResourcePackage，并按最终 FQN 做层覆盖。这两条链路都没有表达“Builtin base + 有序 overlay → 原子物化的唯一最终 VFS”，也不能稳定承载文件 identity、删除、移动、XNL mutation、升级重放和冻结恢复。

本 Track 先冻结宿主侧 authority contract 和迁移验收面，不提前实现 XNL VFS materializer，也不修改正在由并行工作演进的 registry/agent authoring 实现。后续跨项目 Track 必须以这里定义的 Effective VFS snapshot、read port、materialization plan/receipt 与 revision fence 为边界。

## “要做”和“不做” (Goals / Non-Goals)

**目标：**

- 把 `Builtin → home overlay → workspace overlay → strict validate → atomic publish` 固定为唯一 authority 顺序。
- 定义存储中立的宿主侧 Effective VFS snapshot/read port、overlay descriptor、materialization plan/receipt 和 rejection diagnostic 契约。
- 明确旧 `ResourceVfs` 只是 Effective VFS 的兼容只读文本 projection，不再是可写 authority。
- 通过行为 delta 删除按物理 root/FQN 直接覆盖的旧条款，加入路径、node identity、XNL identity、FQN 四层身份和冻结/升级语义。
- 建立可执行 contract tests 与后续 Track 可直接消费的 RED acceptance inventory。

**非目标：**

- 不在本 Track 实现 XNL VFS diff/apply/CAS 或目录 overlay materializer。
- 不让 Halfcode compiler 直接依赖 Eidolon、BunFS 或物理 `.eidolon`。
- 不迁移正式 Coding Agent，不切换 registry consumer，不改 autonomous authoring 写路径。
- 不把 FQN 作为 overlay key，也不引入 Kubernetes Server-Side Apply field manager。

## 变更内容（What Changes）

- 新增 Effective Eidolon VFS authority TypeScript contract，区分 immutable base、overlay intent、candidate、admitted snapshot 与 audit receipt。
- 新增纯 contract guard，约束层顺序、revision fence、admitted/rejected receipt 的完整性。
- 新增行为 delta，移除旧的 physical root / exact-FQN layer precedence，并声明唯一 Effective VFS read authority。
- 新增 contract tests 和 authority baseline 报告，固定未来实现必须满足的失败关闭、冻结和兼容边界。

## 影响范围（Impact）

- 受影响的能力：`eidolon-resource-native-app-registry`
- 受影响的代码：`cell/packages/symbiont-contract/src/resource/`、`cell/packages/symbiont-logic/src/resource/` 及其测试
- 后续消费者：RuntimeConfig、Halfcode ResourceTree/Registry、AIAgentDefinition、Ctrl/Data Workflow freeze/recovery、resource authoring
