# Design：四 Skill closure、原子迁移与渐进上下文

## 1. Authority map

### Halfcode

Halfcode 0.2.3 独占以下事实与变换：

- ResourcePackage、Catalog、KindDefinition 与 XNL load/containment；
- ApplicationAssembly module composition；
- SkillCapsule identity/version、typed sibling dependency、ResourceMappings；
- dependency-first topology、collision/file-set/content preflight；
- planned canonical bytes、capsule/closure digest 与 provenance；
- isolated output-root apply receipt。

### depa-flows

`ai-workflow-flow-dsl-reference@0.1.0` 独占 Flow DSL reference module 的 canonical projection：29 个 WikiPage paths、bytes、source digests 与 package provenance。它不安装 Skill，也不携带 Eidolon operations。

### Eidolon

Eidolon 只拥有：

- 三个产品 Skill 的 host semantics 与操作说明；
- build-time module binding 和 generated plan transport；
- global root、whole-root transaction、ordinary Skill preservation；
- `.system-skills.xnl` installed readback；
- runtime exact resource delivery、workflow tools、actor/stage/tool policy。

Eidolon 不排序 dependency graph、不复制 external docs、不重算 Halfcode plan identity，也不从自然语言推断 stage、Kind、topology、operation 或 authorization。

## 2. Resource modules and closure

Build 使用三个 `AuthoringModuleDescriptor`：

```text
Halfcode ResourceDsl module (published 0.2.3)
  ├── canonical generic KindDefinitions
  └── Halfcode.ResourceDsl.Skill.System@1.0.0

DepaFlowsFlowDslReference module (published 0.1.0)
  └── 29 WikiPages + package provenance

EidolonAnchorSystemSkills module (host-owned build input)
  ├── Eidolon.Anchor.Skill.Authoring@1.0.0
  ├── Eidolon.Anchor.Skill.Run@1.0.0
  └── Eidolon.Anchor.Skill.DevOps@1.0.0
```

唯一 plan root 是 `Eidolon.Anchor.Skill.DevOps`。Sibling dependencies：

```text
Eidolon.Anchor.Skill.DevOps
├── Eidolon.Anchor.Skill.Authoring
│   └── Halfcode.ResourceDsl.Skill.System
└── Eidolon.Anchor.Skill.Run
```

Depa module 是 Authoring ResourceMappings 的 source module，不是 Skill dependency，所以最终 topology 恰好四项，不出现第五个 `sys-depa-*` Skill。

## 3. Build-time generated plan

独立 generator 在构建期：

1. 读取两个 exact published module loaders；
2. 在隔离 staging 中创建 Eidolon ResourcePackage，并从 Halfcode module 机械复制当前 canonical SkillCapsule KindDefinition；
3. 加载三个 SkillCapsules、metadata/templates/mappings 与 host-owned content；
4. 解析完整 ApplicationAssembly；
5. 以 DevOps FQN 为唯一 root 调用 `planSkillCapsuleDistribution`；
6. 用 Halfcode projection 生成 committed plan module，hydrate 时仅恢复 `content` defensive getter 并 deep-freeze；
7. `generate:check` 在临时目录重新生成并逐字节比较，不允许手改 output。

Runtime/global init 导入 generated plan，不依赖源码 checkout 或 external module 的物理 resource root。这是 standalone Bun binary 的 packaging transport，不是第二 topology authority；plan 每个 identity、edge、file、digest 和 provenance 仍来自 Halfcode。

## 4. Skill contents

### sys-eidolon-anchor-devops

根 `SKILL.md` 只描述 lifecycle routing、组合多个显式产品目标、事实交接与 authority 边界。阶段目录：

- `planning/`
- `coding/`
- `building/`
- `testing/`
- `releasing/`
- `deploying/`
- `operating/`
- `monitoring/`
- `improving/`

Code 阶段要求通过通用 `Skill` 加载 `sys-eidolon-anchor-authoring`。Deploy/Operate/Monitor 要求加载 `sys-eidolon-anchor-run`。Build/Test/Release 负责确定性 proof 与 publication gate 的产品编排，不复制 Authoring operation 正文。

### sys-eidolon-anchor-authoring

Authoring 只拥有：

- 根级 authoring control loop；
- `operations/` 下的 create/open、inspect、batch patch、validate/prepare、publish 等结构化协议；
- `references/flow-dsl/**` generated materials；
- 调用 sibling `sys-halfcode-resource-dsl` 获取通用 XNL Resource DSL 的渐进说明。

它不拥有 parser、VFS、CAS、digest、static projection、build 或 publication transaction 算法。这些由 native component/Halfcode/depa processors 确定性执行。

### sys-eidolon-anchor-run

Run 只拥有已发布 resource 的 exact entrypoint resolve、instance/binding、start/resume/resolve/reject、inspect/events/result/replay/evidence 操作。当前 `WorkflowResume` 仅可在已有 typed wait protocol 明确支持时提交 `Cancelled` outcome；这不是通用 run cancellation contract。Run 不加载 authoring grammar、不修改 definition、不把 runtime facts 写回 source。

三个新 Skill 的 identity/version 只在 SkillCapsule XNL 出现。YAML 不重复 name/version；payload 不含旧式 `system-skill.xnl`。安装 manifest 与 `references/.halfcode/provenance.json` 都是 derived readback，不是新的 identity writer。

## 5. Global init migration

`SystemSkillInstaller` 保留现有成熟 whole-root transaction，但 managed candidate source 改为一份完整 generated plan：

1. 在隔离 root 调 Halfcode applier；
2. 对 receipt、closure digest、topology、target set 与 planned bytes 做 readback；
3. 投影四项 `halfcode-distribution` manifest entries；
4. 把普通非 `sys-*` assets 与四项 managed output 合入同父 candidate；
5. 完整验证后替换 live `skills` root 一次；
6. final readback 成功后清理 backup。

build-time generated plan 还必须投影唯一的 `ExpectedManagedSystemSkillSet`。运行时在装载任何 `sys-*` entry 之前，以这份 derived projection 校验 `.system-skills.xnl` 的 exact identity、version、capsule FQN、closure digest 与文件 digests；旧 manifest、缺项、额外项或漂移一律 fail closed，并只返回执行 `eidolon global init` 的稳定修复指引。该 admission gate 只是对 Halfcode plan 的 readback，不复制 dependency resolver、topology graph 或 compiler。

旧 `sys-ai-workflow` 不进入 candidate。成功 commit 后自然退出；任一 commit 前或 recovery-path 失败继续遵守上一 track 已验证的恢复规则。不得把旧 identity 作为 alias、软链或未登记目录保留。

生产源删除 `BundledSystemSkillCatalog`、`BUNDLED_SYSTEM_SKILLS` 和 `assets/sys-ai-workflow/**`。`installBundledSystemSkills` 若为内部兼容暂时保留函数名，也不得再表达 builtin 内容 authority；优先改成语义准确的新名并更新内部调用方。

## 6. Generic Skill resource fragments

通用 `Skill` tool input 扩展为：

```ts
type SkillInput = {
  skill: string
  resource?: string
  offset?: number
  limit?: number
}
```

- `resource` 缺省时加载 `SKILL.md`；
- 非空 resource 必须 exact 出现在 `SkillEntry.resources`，禁止别名、substring 或目录猜测；
- managed `sys-*` 先通过 generated plan 的 `ExpectedManagedSystemSkillSet` 验证 manifest 完整身份投影，再使用 `.system-skills.xnl` + `readInstalledSystemSkillResource` 验证 exact path/digest；
- ordinary Skill 使用 physical file、realpath containment 与 declared resources；
- 取得 source text 后统一进入 `LocalTextResourceLoader`，复用 revision、fragment selection、visible coverage、conversation persistence 与 TUI projection；
- offset 默认 1，limit 默认 2000，保持通用 text resource contract。

DevOps 和 sibling Skills 只指示模型下一步读取哪个 operation family 或 reference index。具体 profile/Kind 对应的文件由模型读取 installed references 后选择；host 不维护语义映射表。

## 7. Workflow actor and stage migration

- `WorkflowFulfill` 与 `WorkflowAuthor` 注入 `sys-eidolon-anchor-devops/SKILL.md`。
- prompt/kernel/agent/tool prose 全部更新为新 identity。
- `WorkflowLoadStageContext` 保留工具名和显式 stage enum；只从 DevOps identity 读取 `<stage>/system.md` 与 `<stage>/protocol.md`。
- stage marker/receipt authority 改为 `global:sys-eidolon-anchor-devops`。
- host `STAGE_NEXT_ACTION` prose map 删除；下一动作来自 installed stage protocol。
- `StageToolPolicy` 仍是确定性 capability boundary，并在需要 sibling/reference 读取的 stage允许通用 `Skill` tool；它不增加自然语言语义。
- 增加 `improving` stage 时只定义 explicit enum/tool set 与 Skill content，不从用户文字推断进入该 stage。

## 8. Compatibility and rollback

保留：

- `eidolon global init` CLI 及 JSON/text result shape；
- `WorkflowFulfill`、`WorkflowAuthor`、`WorkflowLoadStageContext` tool names；
- workflow authoring session、proof、publication、definition、instance 与 run stores；
- current actor/provider/tool/session runtime；
- ordinary user Skills and their declared resources。

不保留旧 `sys-ai-workflow` runtime identity。若新 closure 缺失或 digest drift，调用方返回稳定的“run global init”诊断，不回退旧目录。

## 9. Validation plan

- TDD：先固定当前单体/builtin/全量注入差异，再实现。
- plan：exact set/edges/versions, dependency-first, deterministic projection, generated Flow bytes/provenance。
- installer：migration、repeat、ordinary assets、每个既有 controlled interruption point、post-commit cleanup。
- context：root/resource/offset/limit、unknown/undeclared/unsafe/symlink/drift、visible range reuse、managed/ordinary parity。
- workflow：new identity injection、stage isolation、tool policy、无 host next-action prose、authoring/run separation。
- product：CLI global init JSON/text、TUI/headless actor journey、standalone newly built binary against a fresh temp global root。
- static：无 `BUNDLED_SYSTEM_SKILLS`、旧 asset tree、`system-skill.xnl`、`actions/`、manual Flow DSL body、natural-language regex/keyword/substring/ordered heuristic。

项目 `codument/config/modeling.xnl` 明确 `enabled=false`，本 track 不创建 modeling delta；结构目标由本 design、behavior deltas、tests 与 implementation evidence 持有。
