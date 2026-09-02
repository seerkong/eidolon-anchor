# Mission：establish-overlay-materialized-eidolon-vfs-and-halfcode-runtime

## 背景和动机

Eidolon 已经有 `/.eidolon` 逻辑路径上的 ResourceVFS，并以 home、workspace 物理 `.eidolon` 目录构造运行配置；Halfcode 资源运行时则在另一条链路中直接加载 `~/.eidolon/resources` 与 workspace `.eidolon/resources` 两个物理 ResourcePackage，再按资源 FQN 组合 global/workspace registry。近期为 AI Ctrl/Data Workflow 试制的 Halfcode Coding Agent 仍由 testkit 动态写入 workspace `.eidolon/resources`，因此没有 `.eidolon` 就没有这份成熟 Agent 定义。

这偏离了原始 VFS 设计：程序内嵌内容应当是可复用 base，home/workspace `.eidolon` 应当表达 path overlay 或 mutation；overlay 在资源消费之前被物化为唯一的 Effective Eidolon VFS，运行配置、Halfcode compiler、AgentDefinition 和 Workflow runtime 都只读取这份最终态。其思想对应 Kustomize 的 base/overlay/build：base 不感知 overlay，overlay 以有序 patch 定制 base，下游只消费独立的 build 结果。

XNL 已具备本改造需要的核心原语：`#id` 对齐、`diffNodes`、严格且原子的 `dryRunMutations`、VFS `expectedId`、文件 create/delete/move/rename、XNL `CONTENT_UPDATE`、revision/CAS 与稳定 VFS snapshot 序列化。Halfcode CLI lite 已证明 BunFS 文件嵌入与 source/embedded read-effect 双实现可行；但它当前主要把模板安装到物理 workspace，不提供本 Mission 所需的 Effective VFS authority。Halfcode compiler 当前又直接依赖 `node:fs` 的 `rootDir`，需要补充存储中立的 VFS read port。

## 目标

- 将“先 materialize 唯一 Effective Eidolon VFS，再做 Halfcode 语义投影”确立为资源运行时 authority，并修订当前按 FQN 组合 global/workspace 层的行为真源。
- 以带稳定 node identity、内容摘要和版本 revision 的 XNL VFS snapshot 表达 Eidolon 内嵌 base，并在最终 Bun 编译产物中通过 BunFS 携带。
- 让 `~/.eidolon` 与 workspace `.eidolon` 按明确顺序成为 overlay：同逻辑路径文件表示 replace/add，显式 VFS mutation 表示 create/delete/move/rename，XNL content mutation 表示文件内结构化扩展。
- 所有 overlay 先经过 identity/precondition 校验、全量 dry-run、Halfcode 最终资源校验，再原子发布新的 Effective VFS revision；失败不暴露半应用状态。
- Halfcode compiler 通过通用 VFS read port 从唯一 Effective VFS 的 `/.eidolon/resources` 加载资源，不直接认识 BunFS、home/workspace overlay 或 Eidolon 物理路径。
- 将成熟 Halfcode Coding Agent 从 proposition testkit 迁入 `mod-ai-coding` 所有的正式资源包；无物理 `.eidolon` 时可直接使用内嵌 Agent，`.eidolon` 可通过替换或 mutation 定制。
- 迁移现有 runtime config、Halfcode registry、resource authoring、definition freeze/recovery 与 Ctrl/Data Workflow 集成，使它们共享同一 Effective VFS revision 和可审计 materialization receipt。
- 保持 provider-visible 稳定 Agent prefix：运行中的 Actor/Workflow 冻结精确 Effective VFS 与 resource closure，新 overlay 只影响显式新 epoch 或新运行。

## 非目标

- 不把 Halfcode FQN 作为 overlay 第一覆盖键；FQN 只在最终 VFS 物化后承担资源身份、引用与重复校验。
- 不把 BunFS 内容解压到临时目录后伪装物理 ResourcePackage。
- 不在 Halfcode compiler 内引入 Bun 依赖或 Eidolon 专用路径约定。
- 不在第一版复制 Kubernetes Server-Side Apply 的多 field-manager ownership；global/workspace overlay 顺序显式，冲突以 base revision、file identity 和 mutation precondition 判定。
- 不在 Mission 文件中直接实现产品代码。行为、代码、测试和发布候选均由真实 Track 在各 owner 项目完成。
- 不在本 Mission 中完成所有 Eidolon Agent 向 `AIAgentDefinition` 的全量切换；本次以 Workflow Coding Agent 和相关资源链路完成可复用试水与迁移基础。

## 成功判据

- 编译后的 Eidolon 在完全没有 home/workspace `.eidolon` 时，仍能从 BunFS base 构造有效 `/.eidolon` VFS 并执行正式 Halfcode Coding Agent。
- 普通同路径替换、撤销替换后的 base 回退、显式 delete、文件 move/rename、XNL 结构 mutation 都有确定且相互区分的语义。
- 同一 overlay 在无冲突的新版 base 上可重放；file identity、`valueBefore` 或 base revision 冲突时 fail closed，保留上一有效 revision 并给出可重规划诊断。
- Halfcode compiler 对物理目录和 Effective VFS read port 产生等价 ResourceTree/content identities；运行时不再直接组合 builtin/global/workspace Halfcode registry。
- Effective VFS 是运行期唯一读 authority；Halfcode Registry 是其单向 projection，不能反向覆盖 VFS，也不存在 ResourceVFS、物理资源层和 registry 三份可写真相。
- resource authoring 通过 mutation/transaction 形成新 Effective VFS，只有最终 Halfcode readback 与 receipt reconciliation 成功后才可 freeze 为 executable task proof。
- Ctrl Workflow、Data Workflow、无 Workflow Coding Agent 的确定性 E2E、fresh recovery、compiled binary/local install 全部通过；运行中 frozen Actor 不受磁盘 overlay 漂移影响。
- 当前 `eidolon-resource-native-app-registry` 等受影响 Behavior 完成 delta/晋升，不再保留“global/workspace 以 FQN 分层覆盖”为最终产品语义。

## 为什么需要 Mission 而不是 Track

该目标同时改变 XNL VFS 的可复用 overlay/runtime surface、Halfcode compiler 的输入端口、Eidolon BunFS build、资源 authority、动态 authoring transaction、Agent 资源归属、运行冻结与跨模式 E2E。它跨三个 owner 项目，存在旧行为真源迁移、外部包版本协调、base 升级冲突与运行期恢复不确定性，需要按实际证据持续观察和重规划。单个 Track 无法在保持各 owner 边界的同时安全闭环。

Mission 只负责 desired DAG、跨项目 Track 生命周期、反馈观测和受控重规划。所有规范、实现、测试与候选包改动均由 `mission.xnl` 中绑定的真实 Track 承担。
