# skill: codument-init（项目初始化 · 落地自包含工作区）

你是负责用 Codument 方法论设置和管理软件项目的 AI 代理。本 skill 在目标项目落地一个**自包含**的 `codument/` 工作区（所有规则随项目走），并在项目根 `AGENTS.md` 写入受管指针块。

> 本文以 Markdown 为主（说明 / 规则 / 目录清单 / 表格 / 示例）；**程序化的执行流程**（脚手架序列的「已存在→upgrade vs 全新」分支、交互式设置的顺序）用流程标记块（` ```text ` + `@delimiter: --`，构造词汇见 `_operation-spec.md`）。
>
> 口径映射（旧命令 / 旧格式 → 当前标准）：`codument:init`→`codument-init`；`codument/state.json` 不再作为 track 恢复点（恢复点改为 track.xml 的 `Status=ACTIVE`），仅保留 `cli_tools` 作为 init/upgrade-workspace 的安装目标记忆；删除 `config/feature.json`（能力开关并入 `attractor-profiles.xml` 各 `<Profile enabled>`）；`knowledgeSync`/`projectMemory` 开关 → `docs`/`memory` profile 的 `enabled`；不再生成废弃的 `tech-stack.md`；`workflows/workflow.md`（旧单文件）→ `std/sop/workflow.md`（内置规程）+ `workflows/{definitions,instances}/`（引擎级流程存放）。

**重要**：所有用户澄清、选择、确认都遵循 `codument/std/sop/questioning.md` 的 ask-* 协议。不要为了测试运行环境是否支持问答 ToolCall 而发起占位问题；只有存在真实工作流问题（greenfield「你想构建什么」、交互式上下文/产品/工作流澄清、路径/覆盖冲突）时才提问。**默认初始化非交互**——能不问就不问。

---

## 0. 自包含目标（init 的核心）

init 的核心目标是**自包含**：把 Codument 标准、规程与操作提示词落盘进 `codument/std/`（尤其 `std/operations/`），使初始化后所有规则都在项目的 `codument/` 里。落盘后所有引用一律指向 `codument/std/...`。

完整当前工作区布局（见 `codument/README.md`）：

```text
codument/
├── std/                            内置标准（init 落盘、升级刷新；self-contained）
│   ├── AGENTS.md                   入口/路由：指向 tiers/sop（怎么做）、spec（格式）、skills（操作）
│   ├── root-agents.md              项目根 AGENTS.md 受管块模板（init 据此写/刷新）
│   ├── kernel-pointer.md           codument 如何复用 ../dynamic-workflow 的三层内核
│   ├── spec/                       格式规范
│   │   ├── track-xml-spec.md       ★ 重构后的 track 文件规范（含 §0.5 track 目录布局）
│   │   ├── behavior-delta.md       如何写 behavior delta（旧 spec delta）
│   │   ├── behavior-registry.md    behavior 登记表（codument/behaviors/）格式
│   │   └── folder-manifest.md      目录职责自描述 + 补齐机制
│   ├── docs-modeling-fractal/index.md  建模侧分形规范
│   ├── docs-impl-fractal/index.md      实现侧分形规范
│   ├── sop/                        内置执行规程
│   │   ├── workflow.md · questioning.md · validation.md
│   │   └── tdd.md · wave-exec.md · gap-loop.md · archive.md · artifact-sync.md
│   └── skills/                     全部操作 skill（Markdown + 流程块）+ _operation-spec.md + README 索引
├── attractors/                     吸引子载体
│   ├── project.md · product.md     项目/产品级吸引子
│   ├── knowledge-tiers.md          知识分层 + 信息晋升阶梯 + 真源优先级
│   ├── model-driven-docs.md        （docs profile enabled 时）docs 知识入口
│   └── project-memory.md           （memory profile enabled 时）memory tier 吸引子
├── config/
│   ├── attractor-profiles.xml      命名 attractor 组合（coding/docs/memory profile；feature.json 已删）
│   └── operation-hooks.xml         命令生命周期 hook 模板（默认稀疏/空）
├── workflows/{definitions,instances}/  dynamic-workflow（Process Surface）存放目录
├── sop/README.md                   项目自定义执行规程（区别于内置 std/sop/）
├── backlog/README.md               候选工作 + AI 自主度（活的清单）
├── memory/README.md                长期记忆（memory profile）
├── behaviors/                      （运行期生成）behavior 登记表（旧 codument/specs/）
└── tracks/                         （空，含 README）变更追踪目录
```

config 默认值：`attractor-profiles.xml` 含 `coding`/`docs`/`memory` 三个 `<Profile>`，**默认 `enabled="true"`**；profile 开关取代并删除旧 `feature.json` 的能力开关（docs profile 启用 = 开启 docs 知识同步；memory profile 启用 = 开启项目记忆）。`operation-hooks.xml` 落空/稀疏模板。

---

## 1. 顶层脚手架流程（已存在→upgrade vs 全新→fresh）

接收可选参数 `path`（项目根，缺省当前目录）。先判断 `codument/` 是否已存在以决定语义，再按下面的序列落盘。**已存在 `codument/` → upgrade 语义：刷新 `std/`（内置标准随包升级），但不覆盖用户内容（`attractors/` 正文、`config/` 已有取值、`sop/`、`tracks/`、`behaviors/`、`backlog`/`memory` 正文）。**

```text
@delimiter: --
-- #sequence ?scaffold
---- #step ?detect
确认项目根（path 或当前目录）；判定项目成熟度（§2 brownfield/greenfield）
---- /?detect
---- #if ?exists cond="目标 codument/ 已存在"
------ #sequence ?upgrade
-------- #step ?u1
upgrade 语义：仅刷新 std/**（含 skills/、spec/、sop/、分形 index），不动用户正文
-------- /?u1
-------- #step ?u2
config/：补齐缺失的 profile/hook 模板，保留用户已设的 enabled/取值，不覆写
-------- /?u2
-------- #step ?u3
attractors/：按当前 profile enabled 补齐缺失文件（docs→model-driven-docs.md、memory→project-memory.md），已存在正文不动
-------- /?u3
-------- #step ?u4
用 std/root-agents.md 模板幂等刷新项目根 AGENTS.md 的 codument 受管块（块外内容不动）
-------- /?u4
------ /?upgrade
---- /?exists
---- #else ?fresh
------ #sequence ?init
-------- #step ?f1
落盘 std/**：AGENTS.md、root-agents.md、kernel-pointer.md、spec/（track-xml-spec + behavior-delta + behavior-registry + folder-manifest）、docs-modeling-fractal/ + docs-impl-fractal/、sop/*、skills/*（全部 skill 提示词从包内落盘，init 后自包含）
-------- /?f1
-------- #step ?f2
落盘 config/：attractor-profiles.xml（coding/docs/memory profile，默认 enabled=true）、operation-hooks.xml（稀疏/空模板）
-------- /?f2
-------- #step ?f3
落盘 attractors/：project.md + product.md + knowledge-tiers.md；docs profile enabled→加 model-driven-docs.md；memory profile enabled→加 project-memory.md；不写废弃的 tech-stack.md
-------- /?f3
-------- #step ?f4
建空目录骨架：sop/（含 README）、behaviors/、backlog/（含 README）、memory/（含 README）、workflows/{definitions,instances}/、tracks/（含 README）
-------- /?f4
-------- #call ?disc target="§2 项目发现（brownfield 只读扫描 / greenfield 询问并初始化 git）"
-------- /?disc
-------- #call ?ctx target="§3 交互式：project.md / product.md / 工作流（仅当用户要交互；非交互默认据发现结果起草）"
-------- /?ctx
-------- #step ?f5
用 std/root-agents.md 的受管块模板，在项目 AGENTS.md 写/刷新 `<!-- codument:begin -->…<!-- codument:end -->` 块，引用 @/codument/std/AGENTS.md
-------- /?f5
-------- #step ?f6
仅当路径/覆盖出现真实冲突才提问；否则完成默认初始化
-------- /?f6
------ /?init
---- /?fresh
-- /?scaffold
-- #step ?summary
展示初始化摘要（落盘了什么、profile 启用状态、AGENTS.md 受管块、下一步建议）
-- /?summary
```

落盘后用 `std/root-agents.md` 的模板在项目根 `AGENTS.md` 写/刷新受管块——它**只是指针**（何时打开 `@/codument/std/AGENTS.md` + 它能解答什么），块外的项目自有内容不动，便于 `upgrade-workspace` 幂等刷新。

---

## 2. 第一阶段：项目设置（项目发现）

**协议：按此顺序执行设置。**

### 2.0 项目发现

分析现有项目时，要忽略当前 workspace 下一些目录与文件：

- `codument/` 目录：这是让使用 Codument 方法论设置和管理软件项目的文档和配置目录。
- `.gitignore` 中配置的忽略内容：这些是用户强制指定要忽略的。

**检测项目成熟度：**

- **Brownfield 指标：**
  - 存在版本控制目录：`.git`、`.svn` 或 `.hg`。
  - 如果存在 `.git`，执行 `git status --porcelain`；输出非空则为 Brownfield。
  - 存在依赖清单：`package.json`、`pom.xml`、`requirements.txt`、`go.mod`、`Cargo.toml`。
  - 存在源代码目录：`src/`、`app/`、`lib/` 包含代码文件。
- **Greenfield 条件：** 以上指标都不存在，且目录为空或仅包含通用文档（如单个 `README.md`）。

**根据成熟度执行工作流：**

```text
@delimiter: --
-- #switch ?maturity on="项目成熟度"
---- #case ?brown when=Brownfield
------ #sequence ?bf
-------- #step ?b0
宣布检测到现有项目；若 git 有未提交更改，警告用户先提交或暂存再继续
-------- /?b0
-------- #step ?b1
请求权限：进行只读扫描以分析项目
-------- /?b1
-------- #step ?b2
代码分析：优先分析 README.md，扩展到其他相关文件
-------- /?b2
-------- #step ?b3
提取上下文：识别编程语言、框架、数据库驱动、架构类型
-------- /?b3
-------- #step ?b4
推断项目目标：据 README 或 package.json 描述一句话总结
-------- /?b4
------ /?bf
---- /?brown
---- #case ?green when=Greenfield
------ #sequence ?gf
-------- #step ?g0
宣布将初始化新项目；初始化 Git 仓库（如不存在）
-------- /?g0
-------- #step ?g1
询问「你想构建什么？」等待用户回复（ask-single-question-free，见 std/sop/questioning.md）
-------- /?g1
-------- #step ?g2
把用户回复写入 codument/attractors/product.md 的 `# 初始概念` 部分（attractors/ 与 config/ 已由 §1 脚手架建好；不再把 state.json 当恢复状态，能力开关在 attractor-profiles.xml 的 profile enabled）
-------- /?g2
------ /?gf
---- /?green
-- /?maturity
-- #step ?next
完成后立即进入 §3
-- /?next
```

---

## 3. 第一阶段：交互式上下文 / 产品 / 工作流

下面三节是**交互式**完善：默认初始化可据项目发现结果直接起草（非交互），仅当用户选择交互、或信息不足以起草时才发起对应 ask-* 协议提问。

### 3.1 生成项目上下文（交互式）→ `codument/attractors/project.md`

1. **介绍：** 宣布将帮助创建 `codument/attractors/project.md`。
2. **批量提问（加速）：** 每轮可提出 2-4 个问题，每个问题前加 `Q1`/`Q2`… 标识，等待用户按标识逐条回答（ask-multi-question-free）。
   - **约束：** 总问题数最多 5 个。
   - **建议：** 每个问题生成 3 个高质量建议答案。
   - **主题：** 技术栈、架构模式、代码风格、测试策略、Git 工作流。
   - **问题类型：** 累加型（允许多选，加「（选择所有适用项）」）/ 排他选择型（引导单一决定）。
   - **自动生成逻辑：** 如果用户选 E（让 AI 推断），停止提问，据已有信息推断剩余细节。
3. **起草文档：** 对话完成后生成 `project.md` 内容。**关键：** 生成来源仅是用户选择的答案，忽略未选择的选项；不要在最终文件中包含对话选项。
4. **用户确认：** 展示起草内容供审查（ask-single-question-closed）：

   ```text
   A) 批准：文档正确，继续。
   B) 修改建议：告诉我要修改什么。
   ```

   据回复修改或批准后退出循环。
5. **写入文件：** 批准后写入 `codument/attractors/project.md`。
6. **继续：** 立即进入下一节（不再把 `state.json` 写作续跑/恢复状态）。

### 3.2 生成产品定义（交互式）→ `codument/attractors/product.md`

1. **介绍：** 宣布将帮助创建或完善 `codument/attractors/product.md`。
2. **提问：** 一次一个；加速时每轮可并行提 2-4 个问题并用 `Q1`/`Q2`… 标识、按标识逐条回复，保持总问题数不超过 7 个（顺序用 ask-single-question-free，并行用 ask-multi-question-free）。
   - **主题：** 目标用户、核心目标、主要功能、产品愿景。
   - 遵循 3.1 相同的问题格式规范。
3. **起草文档：** 生成 `product.md` 内容；如果已存在「初始概念」（greenfield 阶段写入），在此基础上扩展。
4. **用户确认：** 展示并确认（ask-single-question-free）。
5. **写入文件：** 批准后写入 `codument/attractors/product.md`。
6. **继续：** 立即进入下一节。

### 3.3 选择工作流（交互式）→ `codument/std/sop/workflow.md` 取向 + profile 开关

1. **介绍：** 宣布将配置开发工作流。
2. **提问（ask-single-question-closed）：**

   > 你想使用默认工作流还是自定义？默认工作流包括：
   > - 测试驱动开发（TDD）
   > - 80% 代码测试覆盖率
   > - 每个任务后提交更改
   >
   > A) 默认  B) 自定义

3. **如果自定义（选项 B）：**
   - **问题 1：** 测试代码覆盖率要求？（默认 >80%）（ask-single-question-free）
   - **问题 2：** 每个任务后还是每个阶段后提交？（ask-single-question-closed）→ 落到 track.xml `<Metadata><CommitMode>`（auto/manual）的默认取向。
   - **问题 3：** 是否使用 TDD 流程？（ask-single-question-closed）
4. **生成工作流取向：** 内置规程在 `codument/std/sop/workflow.md`（随包落盘，不重写正文）；用户的工作流选择落为项目级取向——记入 `codument/sop/`（项目自定义规程）或对应 `attractor-profiles.xml` profile 的 enabled（如选「不要 docs 同步」→ 关 docs profile）。引擎级流程定义放 `codument/workflows/{definitions,instances}/`。
5. **继续：** 立即进入 §4 总结（不再写 `workflows/workflow.md` 单文件，也不把 `state.json` 写作执行状态）。

---

## 4. 总结

展示初始化所有操作的摘要：

- 落盘了 `codument/std/`（自包含提示词）、`config/`（profile + hook 模板）、`attractors/`（project/product/tiers + 按 profile 的 docs/memory）、空骨架目录。
- 各 profile 的 `enabled` 状态（coding/docs/memory，默认全开）。
- 项目根 `AGENTS.md` 的 codument 受管块已写入/刷新。
- 下一步建议：可用 `请使用 codument-track skill，创建新变更追踪` 创建新 track，或用 `请使用 codument-implement skill，实现 track: <track_id>` 开始实现已有 track。

---

## 5. 参考

- 工作区布局与设计决策：`codument/README.md`
- track 文件格式：`codument/std/spec/track-xml-spec.md`
- 根 AGENTS 受管块模板：`codument/std/root-agents.md`
- 提问协议（ask-*）：`codument/std/sop/questioning.md`
- 知识分层与晋升：`codument/attractors/knowledge-tiers.md`
- profile / hook 配置：`codument/config/attractor-profiles.xml`、`codument/config/operation-hooks.xml`
