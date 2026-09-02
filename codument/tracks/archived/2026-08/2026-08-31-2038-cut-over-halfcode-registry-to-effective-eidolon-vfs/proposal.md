# 变更：将 Halfcode Registry 切换到 Effective Eidolon VFS

## 背景和动机 (Context And Why)

当前 registry adapter 直接读取 global/workspace 两个物理 ResourcePackage，并在 Halfcode FQN 层决定覆盖关系；source capture、dependency read 和 freeze 又会回读物理文件。这与已经建立的 Effective Eidolon VFS 唯一 authority 冲突，也会让运行中的 registry 在磁盘改变后失去 revision closure。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**

- 从一个 revision-bound Effective VFS 的 `/.eidolon/resources` 加载唯一 Halfcode ResourceTree。
- snapshot、source、profile dependency、KindDefinition digest 与 frozen closure 共享同一 VFS revision。
- duplicate FQN 或 invalid resource 在 projection 时 fail closed，而不是按 physical layer 选 winner。
- 保留现有 `contentIdentityLayers` 和 Agent/Workflow/Holon proof 能力。
- 切换 production WorkflowComponent/Terminal runtime 的 registry 输入，并提供 frozen closure 恢复路径。

**非目标:**

- 本 Track 不重写 workspace resource authoring transaction；它由后续 G5-T2 完成。
- 不让 Registry 反写 VFS，也不让 Halfcode 拥有 overlay materialization。
- 不以临时目录或 BunFS 解压代替 VFS read port。

## 变更内容（What Changes）

- **BREAKING**：正式 registry snapshot authority 从 `global/workspace rootDir[]` 改为单一 Effective VFS source。
- 增加 Effective VFS → Halfcode `ResourcePackageReadPort` 适配和完整 candidate validator。
- 将 physical source reads、profile dependency reads、KindDefinition digest 与 closure capture 改为 snapshot-bound VFS reads。
- freeze 记录 Effective VFS revision/provenance；recovery 从 frozen effective closure 重建只读 port。
- 将旧 physical layer API 限制为短期 isolated authoring bridge，并在 G5-T2 移除写侧依赖。

## 影响范围（Impact）

- 受影响的能力：`eidolon-resource-native-app-registry`
- 受影响的代码：`ai-organ-logic/resources`、Workflow component/runtime binding、terminal runtime wiring、registry/freeze/recovery tests
