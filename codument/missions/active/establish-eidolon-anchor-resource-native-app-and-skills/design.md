# Mission Design：Resource-native App 与系统 Skill 控制面

## 控制目标

期望态由四层相互独立的 authority 构成：

1. Halfcode 提供通用 XNL resource package、catalog、KindDefinition、normalized ResourceTree、layering、revision/provenance、SkillCapsule dependency closure 与 deterministic distribution plan。
2. depa-flows 消费 Halfcode normalized facts，只定义 AI Workflow、Agent、Material 和 run freeze 的领域契约与投影。
3. Eidolon 消费上述公开 API，拥有 global/workspace root binding、App resource registry adapter、actor/effect/session runtime、global init、TUI/CLI/native tools。
4. 具体 App ResourcePackage 组合 workflow、agent、skill、prompt、schema 和 material；非 workflow 内容必须留在其 owner 项目。

实际态由三个 ProjectRef 对应项目中的代码、published package API、canonical docs、tests、track 状态，以及本 mission 的 analysis/reports 投影构成。ACE Workbench 和 Fabric平台 只提供只读比较证据，不成为新的 authoring authority。

## Project 与写入边界

- `eidolon-anchor` 是 host，拥有 mission 控制面、Eidolon adapters、system Skill installation、runtime 和产品验收。
- `halfcode-compiler` 是 external，拥有全部通用 resource/SkillCapsule compiler changes。
- `depa-flows` 是 external，拥有全部 AI Workflow/Agent/Material 领域资源 changes。
- invocation session 提供 ProjectRef 到 workspace 的临时 binding；持久 mission、track、decision 和 report 不记录机器路径。
- 如果未来为具体非 workflow App 确认新的 owner 项目，必须以 evidence 驱动的 replan 增加 ProjectRef；不得把临时目录或仓库路径写进现有 ProjectRef。

## 资源 authority 与编译链

canonical pipeline 固定为：

```text
XNL ResourcePackage authority
  -> Halfcode loader / Kind registry / layered ResourceTree
  -> domain consumer projection（depa-flows 或其他 Kind owner）
  -> Halfcode SkillCapsule / distribution plan 或 Eidolon App registry adapter
  -> Eidolon staged global installation / actor runtime
```

`AIWorkflowAppBundle` 可以保留为 workflow 领域级 App projection 或 entrypoint collection，但不得拥有通用 Catalog、目录扫描、overlay 或安装 authority。Eidolon 的 root path、global-only policy 和安装 transaction 是 host policy，不进入 Halfcode parser，也不进入 depa-flows definition。

## Skill 拓扑

安装后的目标依赖图：

```text
sys-eidolon-anchor-devops
├── Code -> sys-eidolon-anchor-authoring
│           ├── base grammar -> sys-halfcode-resource-dsl
│           └── selected Kind -> generated versioned references
└── Deploy / Operate / Monitor -> sys-eidolon-anchor-run
```

职责边界：

- `sys-halfcode-resource-dsl`：只描述 ResourcePackage、Catalog、KindDefinition、XNL channels、source shapes、identity/ref、VFS、authority/projection 与静态诊断；不写 workspace、不调用 Eidolon tools。
- `sys-eidolon-anchor-devops`：薄的 Plan/Code/Build/Test/Release/Deploy/Operate/Monitor/Improve 生命周期路由器，只传递阶段事实并加载专属 Skill。
- `sys-eidolon-anchor-authoring`：拥有 `operations/`、AuthoringChangePlan、CAS/digest apply、resource Kind 选择与 diagnostics routing；不拥有通用 DSL 或领域 Kind 真源。
- `sys-eidolon-anchor-run`：拥有已发布 resource entrypoint 的 resolve、binding/instance、start/resume/resolve/reject、inspect/replay 与 evidence 操作；不加载 authoring grammar，不修改 definition。`Cancelled` 只在既有 typed wait-resume protocol 明确支持时作为 outcome，不扩张为通用 run cancellation contract。

Halfcode SkillCapsule 必须显式表达 sibling Skill dependency 或等价 typed relation，编译器校验 identity/version/closure 和 target collision，并生成一次多 capsule distribution plan。Eidolon 只消费该计划并执行 staged atomic replace；不得重新实现 capsule dependency resolution。

## Authoring 与运行事实分离

Authoring 产生 ResourcePackage source revision、validation/build evidence 与 release candidate；Release 固化 immutable artifact；Deploy 生成独立 binding/instance；Run 生成 session/run id、snapshot、RunGraph 和 receipts。运行 evidence 不回写 source definition。

Resource-native publication 必须以整个 workspace ResourcePackage 为 transaction boundary：candidate 保留既有 Agent/Prompt 等资源，经过 Halfcode/depa proof 后，以 expected base package revision 做 CAS，再原子替换 `.eidolon/resources`、刷新 component-owned registry 并验证同一 snapshot 的 readback。`.eidolon/workflows` 中的 legacy workflow bundle 仍是 VFS authoring artifact，不能仅通过返回 `resource://` 字符串取得 ResourcePackage authority。

AI Workflow Agent 节点使用 `resource://<agent-fqn>` 指向 `AIAgentDefinition`。depa-flows 编译 ordered messages、resource/material refs 与 semantic fingerprint；Eidolon adapter 将 normalized agent definition 投影到已有 AgentRegistry/actor config，并通过通用 actor/mailbox/provider/tool/session runtime 执行。不得复制 agent runner，也不得创建 workflow-specific history、compactor 或 session store。

## Track 切片原则

- Halfcode track 只改变通用机制或 Halfcode-owned SkillCapsule，不写 Eidolon policy。
- depa-flows track 只改变 workflow domain contract/logic/docs/examples，不实现 host roots、installer 或 actor provider。
- Eidolon track 只消费公开 package API，负责 adapters、system authority、tools、installation 与用户 surface。
- 每个 candidate TrackLink 只在一个叶任务上出现一次；真实 track 创建后原地绑定，验收和归档由该 track 自己拥有。
- 已完成但未归档的 `optimize-ai-workflow-authoring-control-loop` 作为回归基线；新 track 不重开其性能/proof/context-policy范围。

## Codument 版本兼容

host mission 按当前工作区内置的旧版 `codument/std` 规范维护 `mission.xml`。当前系统正在开发中的新版 Codument CLI 不作为执行前提；需要 CLI 时可以跳过并使用 XML/XNL parser、测试或其他 best-effort 验证。外部项目创建 track 时遵循目标项目自己的当前 Codument authority 和序列化格式，host mission 仅持久化路径无关的 ProjectRef 与 track id。

## 受控重规划

以下证据触发 replan：

- Halfcode 当前 API 已具备某个候选能力，track 可缩小或 supersede。
- Halfcode 的 layered registry 与 Skill distribution 需要拆成更多独立发布批次。
- depa-flows 的旧 AppBundle/catalog 已有外部消费者，需要兼容 projection 而不能直接删除。
- system Skill sibling dependency 无法由 Halfcode 当前 Kind contract 表达，需要先升级 KindDefinition 或 distribution API。
- Eidolon 的 system authority loader 仍强绑定单 Skill/stage，必须先拆 infrastructure 与内容 migration。
- 真实 TUI/CLI 验收暴露 provider、tool schema 或运行 receipt 问题，但不得以 workflow/product 名称增加 host 特判。
- 用户确认具体非 workflow App 的 owner 项目，需要新增 ProjectRef 和独立 track 分支。

每次 replan 必须有 implementation/test/consumer evidence 或 human decision，写入 reports，递增 mission revision，并说明 actual、desired、diff 与 DAG 变化。

## 风险与控制

- 通用资源职责再次泄漏到 depa-flows/Eidolon：通过 dependency scan、public API review 和禁止第二 scanner/catalog 的静态验收控制。
- 多 Skill 安装出现部分版本：通过 Halfcode complete plan、Eidolon staging、全 closure preflight、atomic replace/readback 控制。
- generated references 漂移：每份输出记录 source FQN、apiVersion、content digest 与 generated-by；Eidolon 不允许手工修订生成正文。
- system Skill 同时生效导致双 authority：新四件套 readback 成功后才移除旧 `sys-ai-workflow`，失败时保留上一完整安装集。
- prompt 取代确定性验证：Skill 只做语义建模和 operation 选择，parser、catalog、containment、CAS、digest、build 和 state transition 必须由组件执行。
- 为自然语言方便增加 host 模糊匹配：所有 track 均加入 no-regex/no-keyword/no-substring/no-heuristic acceptance scan。
- 外部项目 Codument 格式漂移：由各 ProjectRef 自己的规范拥有，mission 不把某个 CLI 版本当作跨项目 authority。

## 收口条件

mission 只有在全部 bound track 完成并由最终 acceptance track 证明以下事实后才能 completed：

- 通用 resource 和 Skill 编译只有 Halfcode 一个 authority。
- workflow domain resource 只有 depa-flows 一个 authority。
- Eidolon global init 安装四个版本一致的系统 Skill，旧单体 Skill 已退出 authority。
- authoring 使用 `operations/` 和生成 references，run 使用独立已发布资源操作协议。
- Resource-native workflow App 能通过 installed CLI/TUI 从自然语言创建、发布和运行。
- agent resource 复用 Eidolon 通用 actor/session/runtime。
- 无自然语言 host heuristic、无平行 resource scanner/catalog、无手工复制 Flow DSL。
