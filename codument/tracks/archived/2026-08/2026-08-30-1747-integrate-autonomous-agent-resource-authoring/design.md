# Design：Eidolon autonomous Agent resource host

## Authority 映射

| 事实 | 唯一 owner | Eidolon职责 |
|---|---|---|
| Resource authoring proposal/plan/receipt语义 | Halfcode authoring runtime | 实现filesystem transaction port并提供真实planning/effective-registry数据 |
| effective resource registry与layer precedence | Halfcode + `EidolonAppResourceRegistryAdapter` | 通过现有publication fence装载并接纳新snapshot |
| task requirement/candidate/selection admission | depa-flows `ai-workflow-*` | 传递typed facts，绝不按名称、prompt或reason fuzzy routing |
| Agent task closure与semantic fingerprint | depa-flows run-freeze | 保存refs/receipt摘要，恢复时从registry重新冻结并校验同一identity |
| Agent instance creation/targeting | 现有AI workflow checkpoint + Agent effects | 继续使用`selectAIDataAgentDispatch`与`bindAIAgentProcessors` |
| Data任务图 | canonical AI Data RunGraph/checkpoint | preparation只提供固定capability；不增加GoalGraph或catalog authority |

## Host composition

```text
typed task requirement + current registry
  -> project exact AgentDefinition candidates
  -> Controller decision: select-existing | author-new
  -> depa-flows selection admission
     -> existing: no resource write
     -> author-new: Halfcode plan/apply through Eidolon workspace transaction port
          -> atomic file write/CAS
          -> registry publication candidate
          -> durable receipt commit
          -> admitted live effective snapshot
  -> receipt reconciliation (author-new only)
  -> exact candidate selection
  -> existing run-freeze authority
  -> workflow preparation receipt
```

Host service不接收可执行函数、provider对象或动态catalog。`objective`仅作为审计/model evidence；代码级选择只消费schema、tool、effect policy、material port、ContextPipeline与MessageSource等typed facts。

## Resource authoring adapter

workspace layer是唯一可写目标；global layer只读。Adapter从当前snapshot投影Halfcode planning authority（registry revision、KindDefinition、Catalog binding），并把`ResourceAuthoringTransactionPort`映射到以下本地effect：

1. `loadReceipt`：从workspace resource support目录按plan digest读取不可变receipt并验证bytes；
2. `prepare`：在registry publication fence内执行expected-state/CAS检查，以temp file + fsync + rename写入目标single-file authority；
3. `refreshCandidate`：调用同一fence的candidate loader，返回真实loaded tree/registry/layers；
4. `commit`：持久化不可变receipt后把exact candidate交回fence接纳；
5. `rollback`：在commit前失败时恢复create前的absent状态或update前bytes。本Track只向AgentDefinition host开放create。

document URI必须落在workspace package已声明的`AIAgentDefinition` single-file Catalog root；path containment、symlink、UTF-8、wrong Kind/API、stale revision与并发create均fail closed。

## Workflow preparation 与 recovery

本 Track 不让AI Data运行中任意改写capability catalog。Mission preparation先完成Worker requirement的author/select/freeze，再生成该run的固定Agent capability和以下可序列化receipt：

- request/requirement digest；
- definition ref与content digest；
- selection/candidate digest；
- optional Halfcode plan/transaction/receipt digest；
- workflow kind/ref/node与task-proof semantic fingerprint；
- stable instance name，以及instance创建后checkpoint中的exact instance id。

parent definition snapshot不附加新资源：新definition属于live workspace layer；run checkpoint只保存上述refs/digests/receipts。fresh runtime读取receipt后，从live registry重新投影与freeze；只有resource identity、content closure和semantic fingerprint完全一致才恢复task proof。随后现有durable AI state决定`new`或`targeted byId`，缺失/冲突不回退创建替代instance。

## Package candidate 边界

Eidolon是private上层应用，不发布到npm。本Track把direct dependency声明对齐到Mission准备的exact但尚未发布candidate（包括`halfcode-compiler.xnl@0.2.9`、`ai-workflow-contract@0.1.9`、`ai-workflow-logic@0.1.11`、`ai-data-workflow-logic@0.1.14`与`ai-ctrl-workflow-logic@0.1.10`），并在本地以tarball安装进行验证；不使用`file:`/`workspace:`伪装公共包identity，也不执行npm publish。fresh registry install在candidate发布前不是本Track可声称的发布门禁，最终Mission审计必须把该外部状态明确列出。

## 风险与门禁

- 文件已写、checkpoint尚未提交：Halfcode receipt与registry是durable事实，重试按plan digest幂等reconcile，不重复写。
- registry有无关新revision：恢复依赖exact resource closure/semantic fingerprint，不把全局revision漂移误判为definition变化。
- parent snapshot污染：测试比较authoring前后parent frozen closure bytes，必须完全相同。
- host effect发生后控制decision失败：definition保留为canonical existing resource，但未产生workflow task binding就不可执行。
- 高风险authority变更在最后phase运行独立coding AttractorCheck。

## 验证矩阵

- existing compatible candidate：零写入、exact selection、authentic task proof。
- no compatible candidate：author-new真实Halfcode plan/apply/receipt，refreshed registry可选并freeze。
- stale proposal、CAS race、wrong catalog/path/kind、forged durable receipt：无proof且无错误publication。
- authoring后parent frozen snapshot bytes不变，live registry只新增声明resource。
- JSON round-trip后的preparation receipt在fresh host重新投影同一proof；resource content改变则拒绝。
- 首次Worker调用创建一个instance；后续generation与fresh recovery按exact byId target同一instance/session。
- production source无GoalGraph、dynamic Capability Catalog mutation、名称/prompt fuzzy routing。
