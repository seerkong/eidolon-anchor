# codument/sop/ —— 项目自定义执行流程（项目级，非内置）

本目录放**本项目特有**的执行流程 / 方法论（文字或轻结构化）。它与 `codument/std/sop/`（codument **内置标准** sop：workflow、questioning、validation、tdd、wave-exec、gap-loop、archive、artifact-sync）区分：

- **`std/sop/`** = 随 codument 分发、init 落盘的**内置标准规程**；升级时刷新。
- **`sop/`（本目录）** = 项目团队自己加的规程（特定领域套路、团队约定流程），不被 codument 升级覆盖。

## 约定

- 两段式可选（「轻量 XML 骨架 + prose」，同 `std/operations/_operation-spec.md` 精神）。
- 项目自定义 skill / 或对内置 skill 的项目特化，可经 `<protocols><ref>codument/sop/<name>.md</ref>` 引用本目录。
- 与内置规程同名时，项目可在此覆盖/扩展（由引用方决定优先级）。

> 内置规程不放这里——它们在 `std/sop/`。本目录初始为空（仅本 README）。
