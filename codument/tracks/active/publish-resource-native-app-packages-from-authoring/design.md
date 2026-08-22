# Design：ResourcePackage authoring、proof 与 publication transaction

## 1. Authority pipeline

```text
existing workspace ResourcePackage or explicit complete ResourcePackage input
  -> recoverable session /base + /work (whole package)
  -> Halfcode loadResourceTree(candidate)
  -> compose global + candidate workspace registry/content identities
  -> depa App + Agent/Material projections + exact workflow profile loads
  -> immutable proof set bound to working revision and live-base revision
  -> explicit publication authorization
  -> same-parent workspace resource-root transaction
  -> component-owned EidolonAppResourceRegistryAdapter.refresh()
  -> readback-bound publication receipt
  -> separately authorized instance/run
```

Halfcode owns ResourcePackage/Catalog/KindDefinition parsing、containment、layer composition、content identity与dependency snapshot。depa-flows owns App/Workflow/Agent/Material语义。Eidolon只拥有session VFS、workspace/global root binding、host transaction、tool/CLI read models和runtime。任何 projection/receipt都不能成为第二 source catalog。

## 2. Typed session and source acquisition

`WorkflowAuthoringSession` becomes a closed union:

- `artifactKind = "resource-package"`：`/work`是完整 candidate package；target固定为 injected workspace resource layer，记录 `baseArtifactRevision`、`baseRegistryRevision`、candidate package identity以及可选 selected resource refs。
- `artifactKind = "legacy-vfs-workflow-bundle"`：保留当前单 workflow bundle编辑与 `.eidolon/workflows` publication，输出只能是明确的 `vfs://` ref。

新 resource session只能来自：(a) 当前存在且Halfcode可加载的完整 workspace package；(b) 调用方显式提供的完整 ResourcePackage文件集。resource-backed edit按 exact `resource://`解析 selected origin；只有 workspace origin可直接克隆，global origin需显式完整 workspace candidate，避免把global package暗中变成workspace writer。打开时一次复制整树到`/base`与`/work`；每个文件以canonical path和raw bytes参与revision，opaque/binary文件使用base64或等价byte-safe authority，只有通过fatal UTF-8 decode的显式source文件可接受结构化文本patch。后续batch patch不得只保留selected workflow而丢失同包Agent、Prompt、KindDefinitions、binary dependency或其他App。

当前 authoring session root可继续位于`.eidolon/workflows/.authoring/sessions`，因为它是可恢复工作区而不是 published resource authority。workspace publication target必须来自component注入的`resourcePackages.layers[id=workspace]`，不接受模型提供host路径。

## 3. Candidate validation and proof

ResourcePackage proof projector对持久`/work`创建隔离物理candidate，并在一个调用内产生：

1. `packageLoadReceipt`：`loadResourceTree`成功、package id/version、manifest/content tree digest与diagnostics。
2. `registryProjectionReceipt`：用当前global layer与candidate workspace layer执行Halfcode composition/content identity，绑定composition/registry revisions。
3. `appProjectionReceipt`：`projectAIWorkflowAppBundles`的exact App refs、ordered bindings和entrypoints。
4. `agentMaterialProjectionReceipt`：`projectAIWorkflowAgentResources`的exact Agent、Prompt、Tool、MaterialPort/Binding refs与typed edges。
5. `workflowProfileReceipts`：逐个有效App binding按kind读取exact registered workflow authority，通过现有canonical Flow profile loader；代码依赖只按结构化binding/ref读取，不搜索文本。
6. `runResourceReceipts`：从canonical workflow binding中抽取显式Agent task tuple，调用depa `freezeAIWorkflowRunResources`验证Agent/Material closure；不存在Agent task时保持空集合而非猜测。
7. `buildReceipt`：绑定完整candidate文件集合、projection identities、dependency snapshots、assembly/file digests；不dispatch真实effect。

完整proof set必须同时绑定session working revision和open时的live base revision。任一patch都清除旧proof。`preparePublication`可幂等重算或返回同revision的同identity proof，但不触碰live resource root。

## 4. Publication transaction, CAS and recovery

新增host-side `WorkspaceResourcePackagePublisher`（名称可调整）只拥有文件transaction，不拥有resource语义：

- target固定为absolute workspace resource root；lock/journal/staging/backup都位于target同父，禁止跨filesystem rename。
- publication输入包含session id、prepared revision、expected live base revision、proof ids与显式`confirmed=true`。
- target-scoped exclusive lock内重新加载live package，比较exact base artifact/registry revision；不同candidate的并发发布返回稳定CAS diagnostic。
- candidate先在same-parent staging materialize并重新执行Halfcode/depa preflight；随后写入持久attempt journal，按`prepared -> live-backed-up -> candidate-live -> committed`推进。
- commit使用`live -> backup`、`staging -> live`的rename sequence。任一正常异常回滚旧live；进程重启根据attempt id、candidate digest、live/backup/staging状态执行确定性recover，不以目录名称猜测内容。
- component-owned adapter必须提供typed registry publication fence：candidate snapshot在不修改`current`的情况下独立加载；publication fence与普通refresh generation互斥，所有snapshot/source reader受该fence协调，已有snapshot保持旧authority或收到stable retryable diagnostic，未验证candidate不得暴露。
- candidate成为live后，在该fence内从live root重新加载并核对package id、candidate artifact digest、registry/composition revision与projected refs，然后一次性admit新snapshot。不得复用旧in-flight loading promise；readback失败则恢复backup，而`current`始终保留旧snapshot。
- readback成功后先持久publication receipt，再标记committed并清理backup/journal。重复相同session/revision调用返回同receipt；不同revision不能复用attempt。

Publication receipt至少包含：`receiptId/sessionId/sourceRevision/baseRegistryRevision/packageId/packageVersion/artifactDigest/compositionRevision/registryRevision/appRefs/entrypointWorkflowRefs/workflowRefs/agentRefs/materialRefs/proofReceiptIds/createdAt`。所有`resource://` refs必须来自refresh snapshot，禁止由FQN字符串拼接。

## 5. Authorization and child-runtime boundary

Authoring tools仅写session candidate；prepare只产proof；publish只在当前调用显式授权时执行transaction，并明确记录`publicationEffectDispatched=true`与`runtimeEffectDispatched=false`；instance creation/start仍使用独立runtime authorization。外层CLI/TUI session可跨turn保留session/receipt facts，但每次`WorkflowFulfill`允许fresh child。`WorkflowFulfill`增加closed discriminated `continuation` payload：`authoring`只携带session/expected revision/proof ids，`publication`只携带receipt/registry/App/workflow ids，`execution`只携带instance/run ids；每类都从owner store做exact一致性验证。跨child不得依赖ordinary-language request重建这些facts，不复用child conversation history，也不新增workflow-specific session机制。

## 6. Legacy compatibility

`WorkflowCreateBundle`和legacy session继续支持`.eidolon/workflows/<target>`与显式`vfs://` runtime path。canonical ref固定为`vfs://./<target>/manifest.xnl`。create/open/draft/proof/publish/`WorkflowDefinitionRepository.resolve`/capture/freeze/CLI read model全链路必须原样保留该canonical VFS ref；`loadManifest`与`captureSources`不得再根据definition FQN构造`resource://`。legacy publish不调用resource registry refresh，不出现在App list，不可作为resource-backed Agent freeze authority。只有由effective registry record解析并带resource receipt的definition才可产生`resource://`。

历史持久session缺少`artifactKind`时只按schema/version与既有target shape升级为legacy mode；不得读取自然语言或FQN来分类。

## 7. Canonical fixture and KindDefinition ownership

验收fixture是一个物理、完整、显式输入的ResourcePackage，不由production helper逐Kind拼装。它包含：

- package manifest与只覆盖fixture实际资源的KindDefinitions；
- baseline exact `AIAgentDefinition`、Prompt、MaterialPort（及需要的Tool），在authoring前后逐字节相同；
- candidate patch新增一个普通主题摘要App、entrypoint Workflow、Material与MaterialBinding；
- workflow以exact `resource://` Agent ref和结构化node config声明task。

fixture KindDefinitions是该输入package自己的authority，仅用于tests/harness。production不得复制这些文件、维护kind数组或生成通用contracts；通用Resource DSL知识来自已发布Halfcode module/Skill，domain validation来自已发布depa projections。其他调用方也可以提供自己的完整ResourcePackage与KindDefinitions。

## 8. Skills and generated distribution

Authoring `operations/`增加或重写exact资源：

- `open-resource-package.md`：从current workspace或explicit complete package打开whole-package session；
- `inspect.md` / `batch-patch.md`：说明selected refs不缩小writer scope；
- `validate-resource-package.md`：Halfcode/depa proof与typed diagnostics；
- `publish-resource-package.md`：explicit authorization、CAS、registry readback receipt；
- `legacy-vfs-workflow.md`：明确兼容面永不返回resource authority。

`operations/index.md`与DevOps coding/building/testing/releasing协议切换到上述资源。`sys-eidolon-anchor-authoring`由`1.0.0`升至`1.0.1`；DevOps因exact sibling dependency和release协议变化升至`1.0.1`；Run与Halfcode保持`1.0.0`。Halfcode generated plan、expected managed set、installer/readback fixtures同步更新；所有版本仍是`1.0.x`，无`actions/`目录。

## 9. Verification and static boundaries

- whole-package baseline preservation、exact proof、refresh refs、CLI/native/TUI shared component；
- CAS conflict、same-revision idempotence、pre/post swap中断恢复、readback失败回滚、symlink/path containment；
- legacy vfs honest refs、historical session structural migration；
- canonical fixture加载与App/Agent/Material/freeze closure；
- Skill generator/readback/fresh global init；
- production scan无第二catalog/scanner/dependency resolver、KindDefinitions literals、FQN-to-resource string fabrication、natural-languagehost分支、workflow-specific child session/history。

## 10. Codument compatibility

`codument/config/modeling.xnl`与`engineering.xnl`均显式`enabled=false`，不创建delta。Track使用当前strict XNL ports/decision schema，最终P4挂fresh `AttractorCheck(use="coding")`。
