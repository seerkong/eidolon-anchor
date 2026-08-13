## 上下文

项目的 durable decision 已规定“Eidolon actor generates; WorkflowComponent validates and writes”。当前 `WorkflowExperienceCoordinator` 与 `WorkflowAuthoringIntent` 却在 actor 之前解释自然语言并控制 route、scenario 和 starting fact，构成 semantic authority 反转。

## 方案概览

### 1. Global system Skill 是运行时提示词 authority

- global Eidolon 目录默认 `~/.eidolon`，可由显式 global-root 配置替换。
- `eidolon global init` 是系统 Skill 的统一安装与更新入口：从当前 Eidolon 发布物取得全部 bundled system skills，先写 staging、校验 identity/version/resource hash，再逐个原子替换 `<global>/skills/sys-*` 的受管目录。
- `global init` 只替换受 manifest 管理的系统 Skill，不删除或覆盖用户安装的普通 skills；`<global>/skills/.system-skills.xnl` 记录已安装 identity、version、content hash 和产品版本，使未来新增更多系统 Skill 使用同一入口。
- 产品发布物安装版本化 bundle 到 `<global>/skills/sys-ai-workflow`；运行时只从该物理目录读取 AI Workflow prompt/resources，不从 TypeScript 常量或 workspace 同名 skill 形成第二 authority。
- `sys-ai-workflow` 是保留的 system identity。workspace skill 可扩展普通场景，但不得 shadow、patch 或替换该 identity；缺失、版本不兼容或资源不完整时显式诊断，不静默退回旧 prompt。

### 2. Skill 按 DevOps 生命周期组织

```text
~/.eidolon/skills/
  .system-skills.xnl                       # global init 的受管 system-skill 清单
  sys-ai-workflow/
    SKILL.md                                # 全生命周期事件路由器
    system-skill.xnl                        # identity/version/stage/resource graph
    planning/
      system.md                             # 意图、目标、约束、是否需要 workflow
      protocol.md                           # form/topology/starting-fact 规划协议
      scenarios/                            # 由模型按描述选择的场景知识
    coding/
      system.md                             # 写 definition/flow-code 的系统指令
      generation-kernel.md                  # 必注入的最小正确构造集
      workspace.md                          # /base /refs /work /out 与 revision 规则
      flow-dsl/                             # 直接保留 upstream 的层级骨架
        README.md
        provenance.xnl                      # upstream revision + 裁剪清单 + hashes
        foundation/
          depa-axioms.md
          syntax-axioms.md
          naming-axioms.md
        std/
          eager-data-flow/axioms.md
          work-ctrl-flow/axioms.md
          ai-data-workflow/axioms.md
          ai-ctrl-workflow/axioms.md
        spec/
          flow-core/
            domains.md
            files.md
            nodes.md
            orchestration.md
            refs.md
          eager-data-flow/
            domains.md
            files.md
            nodes.md
            refs.md
          work-ctrl-flow/
            domains.md
            nodes.md
          ai-workflow/
            resources.md
            data-workflow.md
            ctrl-workflow.md
    building/
      system.md                             # bundle/resource/code-ref/linking 收敛
      protocol.md                           # assembly 与静态链接产物
    testing/
      system.md                             # diff/validate/dry-run/proof
      protocol.md                           # revision-exact proof 与有界 repair
      diagnostics.md
    releasing/
      system.md                             # review 与 immutable publication
      protocol.md                           # 独立 publish authorization
    deploying/
      system.md                             # published revision -> prepared instance
      protocol.md                           # inputs/material exact binding + preview
    operating/
      system.md                             # execute/resume/resolve/reject/signal
      protocol.md                           # snapshot/RunGraph/runtime fact ownership
    monitoring/
      system.md                             # status/events/result/progress
      protocol.md                           # diagnostics、deadline、incident projection
```

- 顶层目录采用 DevOps 生命周期：`planning → coding → building → testing → releasing → deploying → operating → monitoring`。这既是知识组织结构，也是专属 actor 的显式 stage vocabulary。
- `SKILL.md` 只负责判断当前事实和事件落在哪个 DevOps stage、加载该 stage 的 `system.md`/`protocol.md` 及必需资源，不承担整本 DSL 手册。
- `coding` actor 的 system context 固定包含 `coding/system.md + coding/generation-kernel.md`；generation kernel 是最小正确构造集，不能被只有链接的薄 `SKILL.md` 替代。
- flow-dsl 只属于 `coding/flow-dsl`，并直接保留 `foundation/std/spec` 上游目录形状；这样从物理目录就能审计 L1、substrate 和 AI profile 是否存在，而不是藏在泛化编号文档中。
- 具体 scenario 和完整 reference 由模型按需读取；scenario 由自然语言描述供模型选择，不在代码中用关键词表选择。
- `building/testing/releasing/deploying/operating/monitoring` 只加载各自 stage 资源，不注入 flow-dsl generation kernel，避免验证、发布或运行请求退化成重新 author definition。
- prompt assembly 代码只按 actor 已明确返回的 stage id 解析具名资源并记录 provenance/hash；代码不得从自然语言猜 stage。stage 变更由 actor 输出的结构化 transition 驱动。

### 3. `coding/flow-dsl` 按规范依赖骨架内嵌

- 保留 L1 公理骨架：XNL 四段职责、内容身份、FQN/URI、单/多文件同构、`output = fn(runtime,input,config)`、definition 与 live state 分离。
- 保留公共 substrate：flow-core 的 definition/contract/statements/fault-data-suspension，EagerDataFlow 的 port/completion DAG，WorkCtrlFlow 的 snapshot/wait/resume/decision。
- 裁掉与 AI Workflow authoring 无关的独立产品细节，但保留章节占位与“为何不适用”的边界，防止模型从旧实现臆造语法。
- 添加 AI profile：`AIWorkflowAppBundle`/`ResourceCatalog`、`AICtrlWorkflow`、`AIDataWorkflow`、logical refs、XNL-only authoring、runtime root 注入、RunGraph/invalidation/reuse。
- reference 是 depa-flows 权威文档的发行时裁剪副本，记录 upstream revision 和裁剪清单；一致性测试验证必需章节/示例/禁用语法仍同步。Eidolon 不实现第二套 parser 或规范。

### 4. 专属 actor 与 deterministic component 的 authority 分界

- 专属 actor 接收：原始用户请求、显式 stage、已存在 definition/publication/run 的结构化事实、native tool schemas。
- 模型决定：是否进入 workflow 产品、选 Ctrl/DAG profile、拓扑、resource、starting fact、需要调用哪些工具以及如何写 workspace。
- component 决定：schema/enum、URI 与 VFS containment、revision CAS、definition validation、dry-run/proof、publish/apply、instance/run transition、effect invocation。
- component 禁止读取原始自然语言以推导 scenario、审批、durability、publication、execution 或业务分支。业务 predicate 必须是模型写入 definition 后引用的显式 code export，绝不能由 host regex 代替。

### 5. DevOps stage 与产品 transition 的映射

```text
planning -> coding -> building -> testing -> releasing -> deploying -> operating -> monitoring
              definition workspace           publication   instance     live run     evidence
```

- `planning`：理解目标、约束、是否形成 workflow、选择 Ctrl/DAG/composite 结构和 starting fact；全部由模型完成。
- `coding`：编辑 `/work` 中的 XNL definition 与 flow-code；每次 mutation 提升 revision 并使旧 proof 失效。
- `building`：确定性解析 bundle/resource/code refs，形成可验证的 assembly/link 投影，不产生第二 authoring 真源。
- `testing`：对同一 exact revision 执行 diff、validate、dry-run 和有界 repair，形成 fresh proof。
- `releasing`：展示 review，消费独立 publish authorization，原子形成 immutable published definition；不执行。
- `deploying`：只消费 published revision，推断/收集 inputs 与 exact Material revisions，创建/准备 instance 并 preview；不改 definition。
- `operating`：消费独立 execute authorization，start/resume/resolve/reject。snapshot、WaitHandle、RunGraph、patch/generation/invalidation 都是 runtime facts。
- `monitoring`：观察 status/events/result/progress/deadline/diagnostics，输出业务投影并把事故证据交给相应 stage，而不是直接修改 definition。

编辑与运行仍是两个面向用户的主要产品交互，但内部不再只有粗粒度 authoring/run 两层 prompt，而是由上述八个 DevOps stage 组成。各 stage 有独立 system prompt、协议、工具 allowlist、输入事实和完成结果；所有入口（conversation/CLI/TUI）调用同一 lifecycle service。

## 影响范围与修改点（Impact）

- `cell/packages/mod-ai-kernel`：仅保留触发系统 workflow capability 的简洁系统规则。
- `cell/packages/ai-organ-logic/src/workflow/authoring`：移除 natural-language heuristic authority。
- `cell/packages/ai-organ-logic/src/workflow/prompts`：迁移到系统 Skill；运行时代码只组装结构化事实。
- agent/profile/bootstrap：新增专属 workflow actor、DevOps-stage prompt resolution 和受限工具集。
- terminal CLI：新增 `eidolon global init` 的 system-skill installer/reconciler。
- terminal CLI/TUI：共享同一 Skill/actor，不再拥有隐式语义分支。

## 决策摘要

- 详见 `decisions.xnl`。
- 模型负责模糊语义；组件负责确定性结构和 transition。
- global `skills/sys-ai-workflow` 是产品提示词真源。
- Skill 的知识和提示词按 DevOps stage 组织；编辑和运行是其上层产品交互分组。

## 风险 / 权衡

- Skill 过大导致上下文和延迟上升 → 使用骨架 + references 的渐进披露，并为 workflow actor限制工具集。
- 移除 direct heuristic 后入口可能多一次模型判断 → 由专属 Skill 的短入口协议和结构化 action 限制成本。
- global 与 workspace skill 冲突 → `sys-*` 设为不可被 workspace shadow 的保留 identity，并用测试锁定。
- 模型可能选择无效 form/template → component 只接受 installed catalog 中的结构化 id，并通过 diagnostics 驱动修复。

## 兼容性设计

- 保留现有 native workflow tools 的底层结构化能力。
- 旧 `route`/`scenario` 参数若存在调用方，迁移为 actor 的结构化建议而非 host 决策；没有外部契约证据时直接删除。
- 旧分散 prompt 在迁移期只允许重定向到 global Skill 资源，迁移完成即删除，不能继续成为并列 authority。

## 迁移计划

1. 先用测试锁定 system identity、global-only resolution、资源图完整性和禁止 heuristic。
2. 建立 versioned system-skill bundle、`.system-skills.xnl` 和 `eidolon global init` 原子安装/替换入口。
3. 建立 DevOps stage 目录、lifecycle resource graph 和 stage-specific prompt assembly。
4. 注册专属 actor 与最小 stage tool policy，让 high-level entry 只传原始请求和结构化事实。
5. 迁移 planning/coding/building/testing/releasing，并用 generation kernel 完成 flow DSL proof。
6. 迁移 deploying/operating/monitoring，并锁定 immutable definition/runtime facts 边界。
7. 删除旧 heuristic/prompt/scenario authority，运行跨入口真实 provider E2E。

## 已关闭的研究问题

- KWF 已证明：导航 Skill、generation kernel、完整 reference、scenario pattern、authoring 与 inference/run prompt 必须分层；generation kernel 必须进入编辑 system context。
- flow-dsl 已给出裁剪依赖顺序：L1 foundation → substrate → AI profile；裁剪不能破坏事实 owner、URI、XNL-only authoring 和动态代码边界。
- KWF 的 deterministic host 负责 revision/validate/dry-run/apply/start，模型负责生成与输入推断；该权责直接采用，但 Eidolon 保持 native actor/tool 交互，不引入外部 AI CLI。
- 用户进一步明确：系统 Skill 的信息架构必须覆盖完整 DevOps 生命周期，flow-dsl 的 upstream 目录骨架只落在 `coding/flow-dsl`，其它 prompt 也必须归入对应 lifecycle stage。

## 实现顺序

先完成 global init/system-skill authority，再落 DevOps Skill 资源树和 stage assembly，随后迁移 lifecycle transitions、删除 heuristic，最后执行跨入口验收。
