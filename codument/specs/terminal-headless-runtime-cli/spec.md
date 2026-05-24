## ADDED Requirements

### Requirement: Headless Terminal Command Entry
系统应当（SHALL）在 `terminal/packages/cli` 中提供无头命令入口，用于执行单轮或脚本式 terminal 调用，而不启动 OpenTUI。

#### Scenario: Run headless terminal turn without TUI
- **GIVEN** 用户在项目根或其子目录调用 terminal 命令
- **WHEN** 用户执行无头命令并提供 prompt
- **THEN** 系统直接输出模型返回内容
- **AND** 不进入 OpenTUI 界面

#### Scenario: Run exec from workspace root with stdin prompt
- **GIVEN** 调用方以 `exec -C <workspace> --output-last-message <file> -` 形式启动命令
- **WHEN** stdin 提供初始 prompt 内容
- **THEN** 系统使用 `<workspace>` 作为 headless runtime 的工作根
- **AND** 将 stdin 内容作为本轮初始输入执行
- **AND** 不启动 OpenTUI

#### Scenario: Accept the PolyBench-relevant Codex exec flag subset
- **GIVEN** 调用方传入 `--full-auto`、`--dangerously-bypass-approvals-and-sandbox`、`--ephemeral`、`--add-dir`、`-m`、`-p` 或 `-c mcp_servers={}`
- **WHEN** 系统解析 `exec` 命令
- **THEN** 系统对受支持参数应用稳定且文档化的兼容语义
- **AND** 不要求实现 Codex 全量命令面
- **AND** 不允许对未支持参数产生静默误解析

### Requirement: ExecProtocolGraph As Parallel Headless Protocol Truth
系统应当（SHALL）新增并维护与 `PrototypeStateGraph` 并列的 `ExecProtocolGraph`，作为 headless `exec` 协议状态的正式真相源，而不是在 prototype graph 上叠加补丁式 reducer。

#### Scenario: Exec protocol state is projected from runtime events
- **GIVEN** headless exec 运行期间持续产生 runtime event、history event、tool 状态与 warning/failure 信号
- **WHEN** 系统需要决定 stdout、最终消息和退出状态
- **THEN** `ExecProtocolGraph` 应对这些输入进行 reducer projection
- **AND** 产出最终消息、可见输出、运行状态、warning 与 failure 摘要
- **AND** 这些 headless exec 协议状态不依赖 `PrototypeStateGraph`

#### Scenario: Successful turn writes the final assistant message
- **GIVEN** 调用方传入 `--output-last-message <file>`
- **AND** 本轮 headless exec 正常完成并产出最终 assistant 消息
- **WHEN** 命令进入最终输出阶段
- **THEN** 系统将最后一条最终 assistant 消息写入该文件

#### Scenario: Failed turn does not clobber an existing last-message file
- **GIVEN** 调用方传入 `--output-last-message <file>`
- **AND** 该文件已存在旧内容
- **AND** 当前 turn 失败或未形成有效最终 assistant 消息
- **WHEN** 命令结束
- **THEN** 系统不应以失败 turn 的空结果覆盖该文件

### Requirement: Headless Exec Output Is Short And Deterministic
系统应当（SHALL）让 `exec` 命令的用户可见输出保持简短、稳定且面向最终结果，而不是输出 TUI 专属界面状态或手工 patch 文本。

#### Scenario: Exec emits concise visible output
- **GIVEN** headless exec 正在运行
- **WHEN** 调用方收集该命令的终端输出
- **THEN** 系统输出用户可见的 assistant 结果与必要 warning/failure 摘要
- **AND** 不打印手工 patch 文本
- **AND** 不要求调用方理解 TUI 卡片或 benchmark 专属状态结构

### Requirement: Shared Runtime For TUI And Headless Commands
系统应当（SHALL）将 TUI、现有 headless `run` 命令与新的 `exec` 兼容命令共用同一套 runtime 初始化与 turn 执行基础能力，而不是让 `exec` 重新复制一条平行运行链。

#### Scenario: Run and exec reuse the same runtime foundation
- **GIVEN** `run` 与新的 `exec` 都需要创建 session runtime、执行单轮 turn 并消费流式结果
- **WHEN** 两种无头入口初始化运行时
- **THEN** 它们复用同一套公共运行时逻辑
- **AND** `exec` 只在协议投影、参数兼容和输出语义层面增加行为

### Requirement: Project Root Resolution For Headless And TUI Entry
系统应当（SHALL）在未显式传入项目路径时，自动向上查找最近的 `.eidolon` 目录作为项目根。

#### Scenario: Resolve project root from nested package directory
- **GIVEN** 命令从 `terminal/packages/tui` 之类的嵌套目录启动
- **WHEN** 用户没有显式传入项目路径
- **THEN** 系统向上查找最近的 `.eidolon` 所在目录
- **AND** 使用该目录作为 terminal runtime 的工作目录
