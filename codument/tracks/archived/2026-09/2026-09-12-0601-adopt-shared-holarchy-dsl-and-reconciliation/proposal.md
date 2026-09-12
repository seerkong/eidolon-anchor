# 变更：Eidolon 接入公共 Holarchy 原生 DSL 与调和场景

## 背景与目标

组织公共包已经统一 OrganizationState、ChangeSet、Command、File-XNL authority、有效时刻发行和解释性三方调和。Eidolon 的部分测试建表入口仍使用字符串化数组，组织发行 provenance 仍硬编码旧版本，当前可检查样例同时承担历史字节与重新生成职责。此次接入使这些入口复用公共功能，同时保持旧任务的冻结事实和任务 receipt 的 owner 边界。

目标是把公共场景经过真实 issuer、资源注册、exact admission、execution binding、TaskSpace 和 Product/Ctrl/Data 路径运行；同一组版本与场景证据应能追溯到独立进程恢复结果。此 Track 对应跨项目 Mission 的 Eidolon 接入阶段；全部执行目标和门槛在本目录内完整记录，不依赖会话记忆。

## 变更内容

- 消费已通过上游 conformance 的公共包候选，统一实际依赖与 lock，增加 `holarchy-test-support` 测试依赖。
- 三处领域 `xxxJson` fixture 改用 `createSyntheticTeamFixture`、`createFixtureSeedChangeSet` 等公共原生数据入口；本地 fixture 只装配宿主资源和运行时。
- `issueFileXnlOrganizationFixture` 委托公共 `issueOrganizationFixture`，显式注入 authorization、clock、projection bounds 与实际安装的 issuer package version。
- 保留已保存 v1 authority、tree、receipt 和 issued bytes，新增当前原生样例；历史兼容读取与当前精确重新生成各有独立断言。
- 从公共场景目录取得改名、冲突、转任和后继选择输入；正式组织变更在公共层完成，Eidolon 消费新发行物。
- 验证 Product-only、Ctrl、Data 的同一任务服务、组织演进后的新 admission、旧任务冻结与新进程恢复，以及两个任务 effect/settlement 窗口。
- 增加一次有界真实远端 provider 的 Product-only gate：最多 2 个请求、每请求输出上限 16384 token、总超时 180 秒、无自动重试。缺少计价信息时只报告请求数与真实 usage，不估造金额。

## 影响范围

行为增量归 `eidolon-holon-e2e-resource`。代码接点为 `cell/packages/ai-organ-logic` 的 Holon issuer、fixture、resource generator 和 workflow/product/recovery 测试，以及 `cell/packages/holarchy-eidolon-adapter` 的公共解析兼容验证。必要依赖声明涉及 `ai-organ-contract`、`ai-support` 与相关 XNL 消费面。具体文件和验收命令见本目录 `design.md`。

**BREAKING：** 当前可生成样例改用原生领域字段；版本行的生成 identity 和当前发行摘要可以变化。旧不可变样例的 bytes 与 digest 保持不变，不能通过重算历史证明掩盖升级。

不增加 Eidolon 私有组织 parser、推理规则或 replay 内核，不把本地组织编辑模型塞入 Workflow，也不另建任务 authority。canonical byte 的 Base64 资源信封保留其传输与证明用途。此次不发布 npm、不购买套餐、不改变用户计费配置、不重置已有工作树。

## 执行条件

上游共享场景与候选接入已完成；当前状态以track.xnl为准。提交模式为 manual。真实 provider 的一次有界验收属于已批准 Mission 的必要测试，先实现并验证本地控制与脱敏，再开启一次 live。确认或失败不会通过循环运行扩大请求数。
