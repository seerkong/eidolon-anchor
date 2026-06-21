## ADDED Requirements

### Requirement: Home-Scoped Local Permission Config

系统应当（SHALL）从 home 级 `.eidolon` 目录加载本地权限配置，而不是依赖 workspace 内可被运行时修改的权限真相文件。

#### Scenario: Load local permission rules from home config

- **GIVEN** 用户在 `~/.eidolon/permissions.json` 中声明了权限规则
- **WHEN** runtime 执行 `bash` 或文件工具
- **THEN** 系统从该 home 级配置读取规则
- **AND** 不要求 workspace 内存在权限配置文件

### Requirement: Configurable Allow Deny Ask For Coding Tools

系统应当（SHALL）让 `bash`、`read`、`write`、`edit`、`multiedit`、`ls`、`glob`、`grep` 共享统一的本地权限求值语义，并支持 `allow`、`deny`、`ask`。

#### Scenario: Deny a bash segment by pattern

- **GIVEN** `permissions.json` 将某条 `bash` pattern 配置为 `deny`
- **WHEN** agent 调用包含该 segment 的 `bash`
- **THEN** 工具调用被拒绝
- **AND** 不执行对应 shell 命令

#### Scenario: Ask before reading a guarded file

- **GIVEN** `permissions.json` 将某条 `read` pattern 配置为 `ask`
- **WHEN** agent 通过 `read`、`ls`、`glob` 或 `grep` 访问命中的目标路径或目录
- **THEN** runtime 发起 approval questionnaire
- **AND** 当前执行进入 `questionnaire_wait`

### Requirement: Workspace-External Paths Require Explicit Access Map

系统应当（SHALL）要求 workspace 外路径先命中 `~/.eidolon/workspace-access.json` 中按 workspace 声明的外部目录白名单；未命中时直接拒绝，命中后按授予的 `read/write` 能力执行。

#### Scenario: Deny external path when workspace access entry is missing

- **GIVEN** 目标文件位于当前 `workDir` 之外
- **AND** `workspace-access.json` 未为当前 workspace 声明该外部目录权限
- **WHEN** agent 调用 `read`、`ls`、`glob`、`grep`、`write`、`edit` 或 `multiedit`
- **THEN** 系统直接拒绝访问
- **AND** 不把这类缺失白名单访问静默视为允许

### Requirement: Workspace Access Can Be Granted Through Questionnaire Writeback

系统应当（SHALL）在 workspace 外目录尚未授权时，通过正式 questionnaire 提供目录授权选项，并在用户批准后把结果写回 `~/.eidolon/workspace-access.json`，随后自动重放原始工具调用。

#### Scenario: External read offers read-only or read-write grant

- **GIVEN** agent 通过 `read`、`ls`、`glob` 或 `grep` 访问 workspace 外目录
- **AND** 当前 workspace 尚未对白名单声明该目录
- **WHEN** 系统拦截本次访问
- **THEN** 系统发起 questionnaire
- **AND** 问卷至少提供“授权只读”“授权读写”“拒绝授权”选项

#### Scenario: Approved external read persists grant and retries

- **GIVEN** 外部目录访问触发了目录授权 questionnaire
- **WHEN** 用户批准合适的授权选项
- **THEN** 系统将授权结果写入 `workspace-access.json`
- **AND** 自动重放原始工具调用
- **AND** 本次调用按新白名单成功执行

#### Scenario: Allow external write when workspace access entry grants write

- **GIVEN** `workspace-access.json` 为当前 workspace 声明了某个外部目录的 `write` 权限
- **WHEN** agent 调用 `write`、`edit` 或 `multiedit`
- **THEN** 系统允许本次写入

### Requirement: Bash Permission Parsing Is Segment-Based

系统应当（SHALL）对 shell 输入按可执行 segment 进行解析和判权，而不是只对整条原始命令字符串做模糊匹配。

#### Scenario: Mixed bash command is denied when any segment is denied

- **GIVEN** 一条 `bash` 输入包含多个由 `&&`、`||`、`;`、`|` 或 `&` 分隔的 segment
- **AND** 其中任一 segment 命中 `deny`
- **WHEN** 系统执行该 `bash`
- **THEN** 整次调用失败
- **AND** 不继续执行命令

#### Scenario: Unsupported shell syntax fails closed

- **GIVEN** `bash` 输入包含当前 parser 无法可靠建模的 shell 结构
- **WHEN** 系统尝试为本地权限求值解析该输入
- **THEN** 系统以 fail-closed 方式拒绝执行
- **AND** 不回退到宽松放行

## MODIFIED Requirements

### Requirement: File Tool Access Follows Runtime Permission Boundary

系统 MUST 让 `read`、`write`、`edit`、`multiedit`、`ls`、`glob`、`grep` 的可访问路径由当前 runtime 权限决定，而不是默认无限制访问任意绝对路径。

#### Scenario: Absolute path is no longer implicitly allowed

- **GIVEN** agent 传入一个位于 `workDir` 外的绝对路径
- **WHEN** 文件工具执行该请求
- **THEN** 系统先评估 workspace 外目录白名单
- **AND** 只有命中允许条件时才继续访问

### Requirement: Home Path Notation Is Normalized Before Permission Evaluation

系统应当（SHALL）在本地权限求值与工具执行前，先把 `~/...` 解析为真实 home 路径，而不是将其当作 workspace 相对路径。

#### Scenario: Ls on home path is evaluated against actual absolute path

- **GIVEN** agent 调用 `ls` 并传入 `~/tmp/demo5`
- **WHEN** 系统做路径解析与权限判断
- **THEN** `~/tmp/demo5` 被解析为真实 home 目录下的绝对路径
- **AND** 不会被错误拼接成 `<workDir>/~/tmp/demo5`
