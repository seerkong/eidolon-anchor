# 资源能力与公共宿主接续

## 三种能力
| 能力 | 数据和操作 | Eidolon 绑定 |
|---|---|---|
| 资源读取 | logical URI、稳定 identity、bytes、类型、来源、revision；stat/list/read 与依赖读取 | 指定 revision 的 Effective VFS 只读端口 |
| 草稿编辑 | base/work、结构 mutation、文件 create/update/delete/move、working revision | Session 的可恢复候选工作区 |
| 发布准入 | expected revision、完整候选、proof、提交关联、receipt、query/recover | 当前 Eidolon authority 的 prepare/admit/CAS |

统一契约不要求各后端拥有相同能力。普通文件适配提供明确的基线/草稿语义；未提供事务提交的后端必须返回 capability unavailable，不能伪造 CAS。测试应运行共同能力集并明确区分可选能力。

## 需要覆盖的链路
业务工具、registry 枚举、依赖解析、候选编译和代码材料加载必须使用选定资源来源及闭包，不能仅替换 readText/writeText 后继续访问某个物理 workspace。若执行器需要磁盘材料，受控缓存从已校验闭包生成并校验 identity/digest，缓存不是可反写的资源 authority。

Skill App 本身可来自操作系统已安装包，编辑目标来自 VFS；两者不共享隐含 root。调用不得创建另一份空 VFS 冒充运行中的 Eidolon。未来独立 CLI 根据目标 owner 的生命周期，通过窄 typed 接口调用原 owner 或绑定同一个持久 authority；普通读取不因此一律启动 Serve。

## 与 Halfcode 的边界
当前 Halfcode 有 ResourceEffect 读取协议、WorkspacePort 文件操作、CommandDefinition/显式 runtime、contractLock 与资源材料加载机制，但公开 HostCapabilityMap 没有整包 authoring/publication。本轮形成可验证的接口和消费者适配；不假称现有 LocalFunction 已有发布能力，不通过 workspace 写文件旁路准入。

未来公共化时：通用资源接口与 Host 扩展归 Halfcode；XNL 继续拥有 diff/mutation/VFS 原语；Eidolon 拥有 Workflow 领域规则、写权限、实例冻结和运行 owner。通过公开注册调用同一 Processor，不另建动态 dispatcher。业务 Skill App 获得窄能力，不获得 arbitrary invoke/eval。

本轮验证的是资源端口、实际 Eidolon 装配与后续可接入性；完整 Skill App 安装、发现替换及跨产品宿主退役留给后续 track。

下一阶段可直接消费本轮已验证的三类端口，但还需在 Halfcode 公共包中设计能力发现、窄 runtime 绑定与错误/回执传递，再将 Eidolon 的工具操作映射为动态 App。普通 OS 文件读写能力不足以承接 VFS 的逻辑 URI、revision、准入与恢复；Host 应显式声明所支持能力，业务 App 不能把 VFS URI 转成物理路径自行写入。验收应把本轮相同的 file/VFS conformance 和真实 Skill E2E 接到新的动态入口上。

## 本轮实现接缝

`symbiont-logic/resource/EffectiveEidolonVfsAuthoring` 提供共享端口。生产宿主将整包字节候选转换成 XNL VFS mutation，校验完整候选后使用已有 SQLite publication authority 一次 CAS；同一提交保存所有文件的 before/after 投影材料。Session 只拥有草稿、proof 和恢复材料，不能决定发布是否发生。

配置 overlay 不包含独立 owner 的 `projects`、`sessions`、`workflows` 运行状态目录。特别是正常 `.eidolon/workflows` 下的草稿、proof、冻结实例和运行记录，不能作为自身资源发布的基线输入；否则准备草稿就会制造 SOURCE_DRIFT。实际 `resources` 和配置文件的外部修改仍会使 prepared candidate 失效。生产组合测试必须使用这些正常目录，不能全部把草稿放到外部测试目录而漏掉这个边界。

`WorkflowEffectiveVfsPackagePublisher` 以 session/revision 派生稳定 publicationId。未知结果必须先通过 `WorkflowQueryResourcePackagePublication` 查询 native authority，再恢复既有投影和 receipt；不能重新产生一次发布。会话锁覆盖候选读取、proof 校验、准入和回执登记。仅发布不会执行 Workflow 实例。

标准 KindDefinitions 来自 builtin 的独立 `/.eidolon/contracts/ai-workflow` 包；普通 home/workspace overlay 不覆盖该目录。公共 Halfcode 的 `kindDefinitionImports` 读取经过加载器认证的契约树，业务包无需复制标准定义。冻结闭包保留实际契约字节及身份，自定义 Kind 仍由业务包按正式协议声明。

上游变更通过 `halfcode-compiler.xnl@0.3.2-eidolon-trusted-kinds.0` 的构建发行物接入，未发布 npm。先设置 `HALFCODE_COMPILER_REPO` 指向该版本源码并运行 `bun run prepare:halfcode-trusted-kinds`，再运行 `bun install --force --offline`。候选从真实 tar 解包到被忽略的 workspace package，仅去掉构建用 devDependencies，运行字节保持原样；所有消费者必须解析到同一模块实例。后续正式版本可替换候选，不允许永久跨仓引用私有源码。

正常安装与启动共同使用 `EIDOLON_GLOBAL_DIR`。`scripts/workflow-skill-live-e2e.ts` 默认只准备隔离目录并执行实际 `global init`；加 `--live` 才开启共享预算 relay 和正常 CLI。模型、预算、构建摘要、Skill 安装身份与退出状态写入运行清单，业务通过仍需独立回读产物判定。
