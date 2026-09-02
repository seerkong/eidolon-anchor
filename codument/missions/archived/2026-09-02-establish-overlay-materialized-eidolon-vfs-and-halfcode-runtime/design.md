# Mission Design：Overlay-materialized Eidolon VFS 与 Halfcode Runtime

## 1. 已接受的架构修正

本 Mission 不采用“builtin/global/workspace 分别编译为 Halfcode ResourceTree，再以 FQN 组合 effective registry”的方案。该方案把 overlay authority 放到了语义 registry 层，无法完整表达 `.eidolon` 的路径约定、文件 rename/move/delete、XNL 内部 mutation、基于旧版本 diff 的重放和唯一最终文件视图。

采用的结构是：

```text
BunFS Builtin Base VFS
        │
        ▼
apply ~/.eidolon overlay
        │
        ▼
apply workspace/.eidolon overlay
        │
        ▼
strict validate + atomic publish
        │
        ▼
Effective Eidolon VFS @ revision E
  `/.eidolon/**`
        │
        ├── runtime configuration readers
        ├── Halfcode ResourcePackage compiler
        ├── AIAgentDefinition compiler
        └── Workflow/Actor resource freezer
```

Kustomize 映射如下：

| Kustomize | Eidolon |
|---|---|
| reusable base | BunFS 内嵌、版本化的 Builtin Eidolon VFS snapshot |
| overlay directory | home/workspace `.eidolon` overlay source |
| resources / ordered patches | 同路径 replace/add、VFS mutations、XNL content mutations |
| kustomize build | Effective VFS materialization transaction |
| rendered objects | `/.eidolon/**` 唯一最终文件树 |
| kubectl consumer | RuntimeConfig、Halfcode、Agent、Workflow consumers |

Base 不读取或引用 overlay；consumer 不读取 base/overlay 输入。只有 materializer 同时理解二者，并发布一个完整、独立、不可变 revision。

## 2. 事实源与 authority topology

| 数据节点 | 语义角色 | authority / owner | 关系与约束 |
|---|---|---|---|
| Builtin VFS snapshot | immutable version input | `mod-ai-coding` 等 owner 资源源码 + Eidolon build | BunFS 携带；具有稳定 node id、内容 digest 和 base revision |
| home/workspace overlay | user-authored intent | 对应物理 `.eidolon` 边界 | 只表达路径替换和 mutation，不直接成为 runtime read authority |
| overlay materialization plan | transition input | Eidolon overlay planner | 记录 base revision、顺序、target identity、precondition 和 digest |
| Effective Eidolon VFS | current runtime read authority | 单一 revisioned VFS materializer/authority | 所有 consumer 只读；失败时保持上一 revision |
| Halfcode ResourceTree/Registry | derived semantic projection | Halfcode compiler | 只能从 Effective VFS 派生，不可反写或作为第二文件 authority |
| Agent/Workflow frozen closure | run recovery material | 现有 Agent/Workflow runtime | 绑定 Effective VFS revision、resource content digest 与依赖 closure |
| materialization receipt | historical/audit record | overlay transaction | 证明 base、overlay inputs、candidate、validation 和 admitted revision |

物理写点不等于 authority。BunFS reader、home/workspace filesystem loader、authoring adapter 都只能向 materializer 提交输入；只有成功的 atomic publish 才改变当前 Effective VFS。

## 3. 路径、VFS identity、XNL identity 与 FQN

四层 identity 分工必须保持：

| identity | 职责 |
|---|---|
| `/.eidolon/...` VFS path | overlay 的位置约定与最终文件寻址 |
| VFS node id / `expectedId` | 文件跨 rename/move 和版本重放的稳定身份 |
| XNL element `#id` | `.xnl` 文件内部节点对齐、move 与结构 mutation 身份 |
| Halfcode resource FQN | 最终资源的领域身份、引用、Kind 与 dependency closure |

FQN 不替代路径 overlay。若 overlay 让同一 FQN 最终出现在两个不同文件路径，Halfcode 应在最终 projection 阶段报告重复资源，而不是挑选某层获胜。若需要迁移路径，overlay 必须表达 VFS move/rename 或显式 delete/add。

## 4. Overlay 语义

### 4.1 Directory-shaped shorthand

home/workspace `.eidolon` 中的普通文件按同逻辑路径映射到 `/.eidolon`：

- base 路径不存在：add；
- base 路径存在：whole-file replace；
- overlay 中不存在某路径：no opinion，不是 tombstone；
- 删除一个 replacement 文件后重新 materialize：恢复使用 base 文件。

这保留当前 ResourceVFS “后输入按路径覆盖前输入”的易用语义，但不再直接 merge 成无 revision 的文本 map。

### 4.2 Explicit VFS mutation

显式 mutation 表达 `FOLDER_CREATE|FOLDER_DELETE|FILE_CREATE|FILE_DELETE|MOVE|RENAME|META_UPDATE|CONTENT_UPDATE|EXTEND_UPDATE`。其中：

- `FILE_DELETE` 是从最终 VFS 删除 base 文件，与“撤销 replacement”严格不同；
- move/rename 使用 `expectedId` 保持文件身份；
- create 的 node id 必须稳定保存，不能每次启动随机生成；
- binary/text 文件使用 replacement 或完整 content update，不伪造 XNL 结构 patch。

### 4.3 XNL content mutation

对 `.xnl` 文件的 `CONTENT_UPDATE` 可以携带 XNL mutation batch：

- `#id` 是内部 element 对齐 authority；
- `#id` 不作为普通 payload update；
- `valueBefore` 可声明基线前置条件；
- `diffNodes(old, desired)` 可形成基于旧版本的用户意图；
- `dryRunMutations` 必须先在隔离 clone 上完整成功，再进入 candidate VFS。

建议小 mutation 每个只表达一个目的，按 overlay manifest 中的明确顺序执行。第一版不引入 Kubernetes Server-Side Apply 的 field manager；global 后 workspace 的顺序就是冲突裁决顺序，跨版本安全由 revision、identity 和 precondition 保证。

## 5. Builtin VFS 与 BunFS

Halfcode CLI lite 的 `packages/cli/src/cli/effects/resource.ts` 与 `scripts/build.ts` 证明了：开发时可以读源码目录，compiled binary 中可以从 `Bun.embeddedFiles` 建立只读 resource effect。Eidolon 应复用这一 Effect 边界，但 BunFS 只负责 transport，不拥有 overlay 或最终资源语义。

Builtin base 不应在每次启动时从目录文件随机创建 VFS node id。优先方案是：

1. `mod-ai-coding` 等资源 owner 持有可维护的 `.eidolon` base authoring tree；
2. build-time generator 校验稳定 node identity，并生成 canonical full `VfsSnapshot.xnl`；
3. 最终 Bun compile 将 snapshot 作为 file asset 嵌入 BunFS；
4. runtime 通过 `deserializeVfsSnapshot` 得到 base；
5. source/dev 与 compiled mode 必须产生等价 snapshot revision。

若采用普通文件 + sidecar 作为 authoring 形态，sidecar/node identity 同样必须进入受版本控制的源码，generator 只做确定性 projection，不能成为随机 identity authority。build 应检查所有 required resources 已嵌入，尤其是 manifest、KindDefinitions、Agents、Prompts、MessageSources 与 ContextPipelines。

## 6. Halfcode compiler 边界

Halfcode compiler 当前 `loadResourceTree({rootDir})` 与 XNL loader 直接调用 `realpath/readdir/readFile/stat`。Mission 目标是加入 framework-neutral read port，例如：

```ts
interface ResourcePackageReadPort {
  stat(path: string): Promise<ResourceEntry | undefined>
  readDirectory(path: string): Promise<readonly ResourceEntry[] | undefined>
  readBytes(path: string): Promise<Uint8Array | undefined>
}
```

物理 directory adapter 保持现有兼容 API；Eidolon adapter 从 Effective VFS 实现同一 port。Halfcode compiler 不依赖 Bun、不识别 home/workspace、不 materialize 临时目录。两种 source 必须产生相同 logical path、canonical `vfs://@/...` provenance、authority digest、content identities 与 diagnostics。

Eidolon 不再向 Halfcode 传入 `global`、`workspace` 两个 overlay layer。若一个最终 VFS 内确实包含多个合法 ResourcePackage，package composition 仍由 Halfcode 拥有；但这属于最终资源集合的语义组合，不是用户 overlay 的替代实现。

## 7. Halfcode Coding Agent 的正式归属

当前成熟 Agent prefix 位于 proposition testkit 的 copied profile，`testkit/codument-proposition/support.ts` 动态生成 `Agents/CodeAgent.xnl`、Prompts、WorkspaceAgents 与 StandardContext，并物理写入 workspace `.eidolon/resources`。这是试验脚手架，不应继续拥有生产定义。

目标结构由 `@cell/mod-ai-coding` 负责内容所有权：

```text
cell/packages/mod-ai-coding/resources/builtin-eidolon/
  .eidolon/
    resources/
      coding-agent/
        manifest.xnl
        Agents/CodeAgent.xnl
        Prompts/*.xnl
        MessageSources/WorkspaceAgents.xnl
        ContextPipelines/StandardContext.xnl
```

具体 source authoring 布局可由 Track 在不破坏最终路径契约的前提下调整。Agent 的 FQN 不包含 `builtin`，因为 builtin 只是 base 来源。testkit 最终只创建 Ctrl/Data/普通模式测试目标并引用正式 Agent，不复制生产 bytes。

## 8. Resource authoring 与运行冻结

现有 autonomous `AIAgentDefinition` authoring 以 workspace ResourcePackage 和 effective registry refresh 为 transaction target。改造后必须调整为：

```text
typed authoring intent
  -> Halfcode plan produces file/XNL mutations
  -> apply against current Effective VFS revision
  -> validate complete candidate VFS
  -> Halfcode readback from candidate
  -> atomic publish Effective VFS revision
  -> reconcile materialization + Halfcode receipts
  -> freeze executable task proof
```

写入策略必须明确区分：

- durable 用户 intent 写入 workspace `.eidolon` overlay；
- Effective VFS 是 materialized current authority，可恢复但不反写覆盖用户 overlay；
- author-new 不直接写 BunFS base；
- current workflow parent closure 不因 live overlay 更新而改变；新 Worker 可通过新的 preparation receipt 选择新 revision。

运行中的 Actor、Ctrl/Data Workflow instance 与 provider context 必须冻结精确 Effective VFS revision 和 Agent dependency snapshot。物理 `.eidolon` 改变只能产生新 admitted revision；旧 run 不隐式 live reread。需要接受新 Agent/resource revision 时，创建显式 resource/provider epoch，避免破坏 DeepSeek 稳定 prefix。

## 9. 版本升级、diff/rebase 与失败语义

当用户 overlay 来源于旧 base `B1`，新 binary 提供 `B2`：

```text
diff(B1, userDesired) -> overlay intent M
dry-run apply(B2, M)
  -> applied: validate and publish E2
  -> conflict/rejected: keep E1 or refuse startup according to freshness policy
```

必须覆盖：

- unrelated builtin 改动不阻止 identity/precondition 仍成立的 mutation；
- `expectedId` 不匹配、`valueBefore` stale、XNL identity replacement、目录占位冲突或最终 Halfcode invalid 时 fail closed；
- 失败不产生部分 VFS、部分 registry 或可执行 Agent proof；
- diagnostic 记录 base revision、overlay id/order、target path/node id、mutation index 与原因；
- auto-rebase 只能在严格 dry-run 与最终 readback 都成功时提交；否则交给显式 replan/authoring 修订。

## 10. 兼容迁移

当前 `ResourceVfs { files: Record<path,text> }` 可以作为 canonical XNL VFS 的临时只读 projection，保证 `RuntimeConfigVfsLoader` 等消费者逐步迁移。它不能继续作为第二可写 authority。

迁移期间：

- embedded runtime defaults 进入 Builtin VFS，不再由每个 loader 单独执行“VFS 缺失则 embedded default”；
- physical `.eidolon` loader 从“直接构造最终 map”改成“构造 overlay intent”；
- `EidolonAppResourceRegistryAdapter` 从唯一 Effective VFS 读取；其对 rootDir、realpath、readFile、frozen source capture 的依赖全部转为 VFS read port；
- 现有 freeze receipt 中的 layer 字段迁移为 Effective VFS revision + materialization provenance，同时保留历史 snapshot 的兼容读取；
- 当前 Behavior 中 `global -> workspace` exact-FQN precedence、legacy VFS discovery 等条款通过真实 behavior delta 迁移，禁止代码先行而规范仍声明旧 authority。

## 11. 跨项目 Track 边界

1. `define-effective-eidolon-vfs-overlay-authority`（host）：冻结 behavior delta、authority map、兼容/receipt 迁移与 RED tests。
2. `expose-stable-xnl-vfs-overlay-runtime`（xnl）：补齐稳定 Builtin snapshot、directory overlay 规划、strict atomic materialization/revision 能力及发布候选；不引入 Eidolon 专用语义。
3. `load-halfcode-resource-trees-from-vfs-read-port`（halfcode-compiler）：增加通用 read port，并验证 directory/VFS parity。
4. `embed-eidolon-builtin-vfs-and-coding-agent`（host）：迁移正式 Coding Agent、生成稳定 Builtin snapshot、接入最终 BunFS compile。
   - corrective dependency: `escape-colliding-text-markers-in-xnl-vfs-snapshots`（xnl）：full snapshot 必须为包含 `</?>` 等嵌套 XNL 文本选择 collision-free marker，保持 payload 原字节 round-trip；禁止把 XNL 文件伪装为 binary/base64 绕过。
5. `materialize-eidolon-overlays-into-effective-vfs`（host）：实现 home/workspace overlay、transaction、receipt、compat projection 与 conflict diagnostics。
6. `cut-over-halfcode-registry-to-effective-eidolon-vfs`（host）：迁移 registry、source capture、freeze/recovery 和现有资源 consumer。
7. `migrate-agent-resource-authoring-to-eidolon-vfs-mutations`（host）：把 autonomous author-new 与 workspace writes 切换到 overlay/mutation transaction。
8. `verify-eidolon-vfs-overlay-upgrade-and-agent-runtime`（host）：完成 compiled/local-install、升级冲突与三种 Agent/Workflow 模式 E2E。

每个候选 Track 都必须由其 owner 项目的 `codument-plan-track` 创建真实 behavior delta、proposal、design、TaskSpace 与验收，再由 `codument-impl-track` 执行。Mission 不直接修改这些项目的产品代码。

## 12. 验证矩阵

- 无任何物理 `.eidolon`：compiled binary 能从 BunFS 运行 Coding Agent。
- source/dev 与 compiled BunFS base 的 VFS revision、node identities、file bytes 等价。
- 同路径 replace 生效；撤销 replacement 后回退 base。
- explicit `FILE_DELETE` 删除 base 文件，不被误解为 no opinion。
- VFS rename/move 保留 node id；旧路径不残留。
- XNL content mutation 使用 `#id` 定位并保持 identity skeleton。
- B1 overlay 在 B2 非冲突变更上重放成功；stale `valueBefore`、changed `expectedId`、duplicate FQN、invalid KindDefinition 全部 fail closed。
- mutation batch 中后段失败时，不发布前段变化；fresh process 恢复上一 admitted revision。
- runtime config 与 Halfcode/Agent consumers 读取相同 Effective VFS revision。
- author-new 成功时 workspace overlay、materialization receipt、Halfcode readback 和 executable proof 闭合；失败时均不可见。
- 运行中的普通 Agent、Ctrl Workflow 与 Data Workflow 在 workspace overlay 改变后仍恢复原 frozen closure；新 run 显式选择新 revision。
- provider request 的稳定 MessagePrefix 不因每轮 VFS 读取发生变化；接受新 revision 才产生显式 epoch。
- TUI/server/CLI build、compiled local install、主要资源与 workflow suites 通过。

## 13. 受控重规划条件

- 若 XNL VFS 现有 public API 已完整满足需求，不为形式对称创建无变化的外部 Track；先记录 evidence，再将对应节点 SUPERSEDED，并让 host Track 只消费已发布能力。
- 若 Halfcode compiler 的 source abstraction 需要改变 canonical provenance 或 content identity，先在 compiler Track 内证明 directory/VFS parity，不在 Eidolon 用临时目录绕过。
- 若 Bun compiled asset 无法直接携带 full VFS snapshot，允许调整 build wrapper 或嵌入多个 canonical asset；不允许运行时解压成为正式 authority。
- 若现有 resource authoring 依赖 physical path contract，先增加 overlay transaction adapter 和双读验证；禁止长期双写 physical package 与 Effective VFS。
- 若旧 freeze/recovery receipt 无法无损映射，增加一次性 versioned migration/legacy reader；新运行只写新模型。
- 若其他并行 Mission 修改相同 resource registry/authoring 文件，Observer 先通过当前工作树与 `.tmp/chat.jsonl` 协调，Reconciler 调整 Track frontier，不能覆盖并行未提交工作。
- 任一实现让 consumer 直接读取 base/overlay、让 Registry 反写 VFS、重新引入随机 node id、静默忽略 stale mutation 或生成第二有效资源 authority，必须停止并 replan。
- Mission 终态前执行 fresh architecture review、bounded gap-loop 与独立 verification；任何 P0/P1 authority 或恢复 gap 未关闭时不得 completed。
