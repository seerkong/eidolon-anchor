# 设计：采用 depa-native AI Workflow Instance/Run 持久化

## 1. Authority map

| 事实 | 唯一 owner | Eidolon 责任 |
|---|---|---|
| ResourcePackage / App / Workflow / Agent definition | Halfcode effective registry | 解析 exact resource refs，并把选中的完整 definition bundle交给 materializer |
| frozen Instance bundle 与 source identity | depa `materializeFlowInstance` contract | 绑定 host support root；不重写目录协议或 digest算法 |
| Run input/config/state/output/sidecars/profile | depa `FlowRunCheckpointStore` | 提供 filesystem support、component lifecycle 与 native surface |
| Agent actor/session/provider/effect | Eidolon generic runtime-control | checkpoint只保存 opaque stable ref、idempotency identity 与 receipt |
| legacy flat facts | migration reader | 只读 inventory/转换输入；迁移后不再写 |

任何 `ctrl/`、`ai-state/`、`data-graphs/`、`agent-executions/` projection 都不能继续成为新运行的 writable authority。若保留查询兼容，它必须从 canonical checkpoint派生，或只读取未迁移的历史事实。

## 2. Physical layout

Eidolon 不发明新目录。host 仅提供一个绝对、受控、无 symlink escape 的 support root，物理结构由 depa package拥有：

```text
workflow-runtime/
  instances/
    <instanceId>/
      instance.json
      definition/             # 完整冻结 bundle，包括 seed/config/code/resources
      runs/
        <runId>/
          checkpoint.json     # 唯一 mutable run authority
          checkpoint.lock*    # depa-owned CAS/恢复协议
```

`state.seed` 是 frozen instance bundle 的只读 facet；每个新 run 的 version 0 checkpoint恰好应用一次。instance 目录本身不产生第二份 mutable Flow state。

## 3. Runtime component

建立 component-owned persistence binding，负责：

1. 将 registry-selected workflow definition 的完整 bytes、canonical source revision/digest/provenance 交给 depa materializer。
2. 对既有 instance owner-first 加载 frozen descriptor与bundle，不因 live definition修改、损坏或删除而重新物化。
3. 为 Ctrl/Data runtime注入同一个 `FilesystemFlowRunCheckpointStore`，不再分别注入 `WorkCtrlFlowStore`、`AIWorkflowStateStore` 或 Data graph writer。
4. Ctrl snapshot与AIData RunGraph只作为 checkpoint的 typed profile state；state、sidecars与profile满足 depa closed reciprocal invariants。
5. query/status/result/replay/evidence从同一 checkpoint和derived receipts投影。

构造保持 Processor 约束：涉及运行时副作用的逻辑保留显式 runtime输入；本 track不引入 runtime-less workflow core。

## 4. Legacy one-way migration

迁移输入是现有 flat store 的 closed inventory：definition revisions/bundles、instances、run descriptors、Ctrl snapshot、AI run states、Data graphs、events、material bindings/revisions、run receipts、Agent execution facts。迁移过程：

1. 在同一 runtime root 建立 durable migration attempt，记录 source inventory digest、target instance/run和阶段。
2. 读取旧 facts并使用 depa公开 conversion/normalizer构造候选 frozen instance与canonical checkpoint；不做宽松 cast或host自建profile schema。
3. candidate complete readback成功后以 CAS 录取；重复或中断恢复返回同一 instance/run/version，冲突内容 fail closed。
4. 写入完成 receipt后，legacy路径只读；新执行永不写 legacy facts。

不得以“双写一段时间”解决兼容。未迁移历史 run可以通过显式 legacy reader读取；一旦开始迁移，任何部分状态都不能被普通 runtime暴露为新 authority。

## 5. Package and compatibility boundary

消费已发布的 exact packages：

- `ai-workflow-contract@0.1.4`
- `ai-workflow-logic@0.1.4`
- `ai-ctrl-workflow-contract@0.1.1`
- `ai-ctrl-workflow-logic@0.1.3`
- `ai-data-workflow-contract@0.1.1`
- `ai-data-workflow-logic@0.1.5`
- `work-ctrl-flow-contract@0.1.1`
- `work-ctrl-flow-logic@0.1.1`
- `instant-ctrl-flow-logic@0.1.2`
- `eager-data-flow-contract@0.1.1`
- `eager-data-flow-logic@0.1.2`

只对直接使用的包增加 direct exact dependency；不使用 range、workspace/file substitute或 registry override。旧 transitive版本可在未参与本 adapter的包中并存，但新 production imports必须解析到上述 identity。

## 6. Validation strategy

- 边界基线：证明旧 flat paths与fresh definition reread问题存在，再验证新路径单写。
- Ctrl/Data真实 fixture：create instance → v0 → node transitions → terminal/wait → fresh component恢复。
- 冻结性：修改、删除或破坏 live definition后，既有instance/run仍只使用 frozen bundle；第二run也使用同一 frozen instance。
- 迁移：未迁移读取、一次迁移、重复迁移、进程中断、冲突facts、真正waiting Ctrl和部分完成Data均覆盖。
- 物理边界：symlink/traversal、malformed descriptor/checkpoint、CAS竞争、abandoned lock恢复均由公开 depa contracts fail closed。
- 静态门禁：production无新写入旧flat paths、无第二checkpoint schema、无workflow-specific actor/history store、无自然语言/标签模糊路由。

## 7. Rollout and rollback

先升级依赖并建立只读 adapter测试，再切 Ctrl/Data writer，最后开启legacy migration。发布失败时保留旧 reader与未触碰legacy facts；成功后回滚只能回到上一个完整二进制，不能让新二进制恢复双写。
