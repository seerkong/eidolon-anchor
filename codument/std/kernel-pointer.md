# codument 如何复用三层内核（kernel pointer）

codument **不重定义**内核；它是 dynamic-workflow 三层标准的一个**领域**。本目录只定义 codument 领域特有的部分。

| 层 | 来源 | codument 用法 |
|---|---|---|
| **Layer 1 内核语言** | `../dynamic-workflow/spec/layer-1-kernel.md` | `<Imports>`(vfs://@/ ./ ../)、`<Ports>`/`<Port>`/`<MaterialBundle>`、`<Extension>` 壳+kind、脚本 `<Adapter lang src>` —— track.xml 直接用 |
| **Layer 2 通用功能** | `../dynamic-workflow/spec/layer-2-functions.md` | `<Hooks>`/`<Hook on>`（track/phase/task 生命周期）；`<Step>`（如需隔离工作单元） |
| **Layer 3 TaskSpace** | `../dynamic-workflow/spec/layer-3-concepts.md §5` | track.xml 的 `<TaskSpace>` 工作树（phase=第一层 TaskGroup）；`<Description>` 元素、status-in-XML、`Task`/`TaskGroup`/`SubNodes` |

## codument 领域新增（`cdt:` = `urn:codument:v1`）

- **`<Track>` 根**：codument 领域流程根（类比 dynamic-workflow 的 `BTWorkflow`）。
- **`<Schedule>`**：调度 overlay（mode + `<Needs>` 依赖边），与 `<TaskSpace>` 并列。
- **`cdt:` Hook check 类型**：`<cdt:AttractorCheck>` / `<cdt:GapLoop>` / `<cdt:HumanConfirm>`（codument 的校验/纠偏/确认），是内核 Extension 派发的领域 kind，**配置直接写在节点上**（无 `agents/` 定义文件）：`AttractorCheck.use` 指 `config/attractor-profiles.xml` 的 profile；`GapLoop` 用 `max-rounds`/`on-exhausted` 属性。
- **`cdt:` TaskSpace 扩展**：`<cdt:Gate>` / `<cdt:Acceptance>` / `<cdt:Criterion>`、`priority` 属性、`cdt:child-mode`（层级执行模式）等。
- **`<Schedule>`** 的 `<Dag>`/`<Node>`（按层依赖）也是 codument 领域调度词汇。

> 同构红利：codument 的 `<TaskSpace>` 与 dynamic-workflow 的 task-space 是**同一种任务树**。dynamic-workflow 的 Step 可经 `task=` 关联 codument track 里的任务节点；codument track 也能被一个外层 workflow 当作 task 子树驱动。
