# 设计与执行边界

## 已确认路线
先完成 Workflow 整包 authoring/publication 与真实 E2E，再以同一能力边界进行完整 Halfcode Skill App 拆分。Skill App 的安装来源与编辑目标可以不同；动态交付不改变权限、资源准入、实例冻结和恢复责任。详细验收见 [acceptance.md](acceptance.md)，后续公共接口要求见 [resource-ports.md](resource-ports.md)。

## 实际故障
WorkflowComponent 在 effectiveVfs 存在时清空 resourceLayers，却只把 registry/layers 传入 WorkflowAuthoringSessionStore；后者强制 workspace layer。已有单文件 authoring port 只接受 expectedCurrentRevision/logicalPath/authorityText，宿主生成一条固定 xnl 类型的 mutation。底层 materializer 已有 mutations[]、prepare/admit、publication association 与恢复机制，应复用现有实现。

模型候选的标准契约错误独立于该装配错误。两个 Holon/Member 任务成功也独立于主会话最终答复和 CLI 退出。

## Data 与 Effect
- Effective VFS revision 与 publication authority 拥有当前准入事实；registry 是带来源的读取投影。
- Session 拥有 base/work 草稿及 working revision。草稿保存不代表 live 发布。
- 宿主提供写入范围及能力，App/模型无权自授；builtin/home/workspace 的有效读取结果不等于全部可写。
- Prepared proof 绑定 base revision、working revision、完整材料摘要、contract lock、验证结果和授权依据。任一相关输入变化需重新准备。
- 文件投影是已提交资源的持久恢复关系；版本提交和多文件磁盘投影分别记录状态，复用 journal/幂等机制，不能宣称多个 rename 构成整体跨介质事务。
- Workflow instance/run 持有其冻结闭包，未来动态操作加载也绑定本次材料版本。

## Processor 与适配
共享 `EidolonEffectiveVfsAuthoringPort` 提供版本化读取、完整文件候选 prepare/admit 与 publication 查询；`WorkflowAuthoringSessionStore` 拥有草稿，`WorkflowEffectiveVfsPackagePublisher` 编排整包 proof、准入与恢复。实际拆分遵循现存 contract/logic/support/capsule 职责。确定性逻辑归组件，Effect 实现执行存储/校验/发布；工具只转换边界输入输出。

单文件 AgentDefinition authoring 的外部签名可保持兼容，内部委托统一写入能力。Physical authoring 若仍有正式消费者，保留显式适配及 conformance；同一目标的 live authority 只有一个。发布回执后只启动具有独立执行授权的实例。

## 契约、错误与 Skill
标准 AIDataWorkflow/AIWorkflowAppBundle 等精确定义从安装契约/registry 获取，模型引用；自定义 Kind 沿用明确的定义和验证流程。拒绝示例指纹替代真实契约。修订既有显式完整包场景，使标准系统 Kind 可由可信 software-owned source 提供，同时继续禁止宿主猜造契约。

错误区分能力不可用、包不存在、契约不可用、验证失败、基线冲突和提交结果未知；结果包含失败阶段、已发生效果和允许的下一步。未绑定能力不得触发 fresh create，未知发布结果先查询回执。Skill 根用于路由，相关操作和契约按需读取，父/子 Agent 分别拥有所需工具和知识，保留实际读取及 provider 可见证据。

Workflow 专用 Actor 的生命周期工具投影不能向普通业务 Agent 继承。工作流节点调用保留其冻结 Agent 的精确工具策略，由宿主提供普通工具构建能力；恢复时重绑同一类能力，不复制 lifecycle facet、DevOps 材料或阶段权限。同步 spawn 与 typed addressed 调用必须覆盖相同隔离边界。

公开组织派单从完整正文派生名称时，名称遵守 canonical label 的 NFC、无控制字符和长度约束；规范化仅作用于派生名称，不能改写实际任务输入。

Prompt 的实际正文是 `template`，Message 的 role 表示消息角色；Authoring Skill 必须与运行时这一读取协议一致，不能把指令放在被忽略的 Content 槽。要求对象输出的 Agent 最终整条消息应为符合 schema 的 JSON 对象；解释可以放到允许的实体字段中，不通过截取围栏或宽松提取掩盖协议违约。

## 兼容与迁移
先加入生产装配的失败测试，再引入接口并切换消费者，最后封闭旧路径。需要迁移持久 session/publication 时以真实样例验证重启恢复；不可恢复的旧草稿需给出明确诊断和保留材料的重建路径，不能静默丢弃。回退不得原地改历史或创建双写者。

## 验证策略与工程默认
按七阶段顺序执行，测试先于对应实现，当前状态以 `track.xnl` 为准。沿用 manual commit；最后阶段配置一次 coding AttractorCheck，其他验证由任务验收命令驱动。独立验收者按 GPT-5.6 Terra 执行，只裁决证据，不修复。未默认增加 GapLoop 或人工停点。项目 modeling/engineering 显式关闭，本 Track 不生成这些 delta，结构结论由本设计承载。

正常工作区 `.eidolon/workflows` 由 authoring/runtime 持有，必须排除在配置资源 overlay 扫描之外，否则草稿自身的写入会制造 source drift。真实空工作区也必须使用有效的 builtin ResourcePackage manifest；测试不能仅覆盖预置完整包的情况。

真实 E2E 的发布版本与编译版本属于不同身份域：以 native association 中的 `receiptDigest` 校验 publication receipt，再由 receipt 的 `effectiveVfsRevision` 与 `compositionRevision` 关联 VFS 与 Halfcode。实例与运行需对应冻结 definition，最终值取 canonical checkpoint。模型总结、CLI 正常退出及 Skill 已安装分别提供辅助证据，不能代替业务链路验证。

Ctrl 验收选择已接通的 `runtime.ai.effects.runAgent` 与精确 MaterialBinding。Ctrl→AIData 的持久调用 resolver、子实例生命周期与冻结依赖协议尚未实现，公共 DSL 语法说明不能替代宿主能力；该扩展不属于本 Track。Data 的 V1/V2 编辑验收独立执行，每次 fulfillment 只针对一个选定工作流和一个完成目标。

验收观察器使用生产状态投影与 profile 对应的返回值路径。组织 TaskRecord 拥有状态，pump subscription 拥有执行输入，MemberRuntime 拥有尝试会话；不能假设这三者共享一份带全部字段的对象。Skill 根源文件和正式渲染后的 provider 材料分别校验身份。用于 E2E 的预算 relay 不把请求体摘要当业务命令 ID：先前成功传输后的相同内容可以是另一任务，必须独立计费；pending/failed/cancelled 的同体请求仍拒绝自动重发。

没有新增待用户裁决的产品取舍。真实 provider 执行前将请求、token、时长预算与授权具象化为运行清单，超出现有授权或改变公共兼容边界时再提出具体决策，不能将预算耗尽写成成功。
