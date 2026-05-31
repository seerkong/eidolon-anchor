## 上下文

当前本项目与该能力相关的实现分成三层：

1. `AiAgentExecutor` 在工具调用前只做通用 gate：
   - tool enabled/disabled
   - plan approval gate
   - web tool network gate
2. `bash`、`read`、`write`、`edit`、`multiedit`、`ls`、`glob`、`grep` 直接在 tool logic 中落地副作用
3. 路径处理仅由 `resolveToolPath()` 负责绝对化，不承担权限判定

因此本次移植不能只在某个单点加 if 判断，否则后续拆分模块时会继续耦合。

## 方案概览

新增一层独立的本地权限模块，分成三部分：

1. `config`
   - 解析 `~/.eidolon/permissions.json`
   - 解析 `~/.eidolon/workspace-access.json`
   - 做 schema 归一化
2. `evaluator`
   - 计算目录覆盖规则
   - 评估 `allow` / `deny` / `ask`
   - 解析 `bash` segment
   - 判断 workspace 外目录是否已授权
3. `runtime bridge`
   - 在 executor 中把 `ask` 转成 questionnaire pending
   - 在 tool logic / 文件 helper 中做最终 fail-closed 守卫

## 分层与落点

建议新增目录：

- `cell/packages/organ-logic/src/permissions/`

建议文件：

- `LocalPermissionConfig.ts`
- `LocalPermissionEvaluator.ts`
- `LocalPermissionRuntime.ts`

这样做的原因：

- 不把权限逻辑塞进 `AiAgentExecutor.ts`
- 不把文件守卫散落到每个 tool logic
- 后续若要把 coding tool runtime 单独拆包，可整体迁移 `permissions/`

## 关键决策

### 决策 1：采用 `~/.eidolon` 作为 authority root

本项目已有：

- `~/.eidolon/llm-provider.json`
- `~/.eidolon/agent-preset.json`

因此本次权限配置保持同一 authority root：

- `~/.eidolon/permissions.json`
- `~/.eidolon/workspace-access.json`

### 决策 2：将 `write` / `edit` / `multiedit` 统一映射到 `edit` 权限类别

这样能保持配置面简单，并与参考实现一致。

### 决策 2.1：将 `ls` / `glob` / `grep` 统一映射到 `read` 权限类别

这些工具虽然实现形式不同，但本质上都在读取目录或文件可见性边界，应共享 `read` 判权，而不是留在权限体系外。

### 决策 3：workspace 外目录 map 缺失时通过 questionnaire 授权并写回

在本项目里继续完善目录授权能力：

- workspace 外目录缺少白名单时，不再只返回硬拒绝
- 而是发起正式 questionnaire
- 用户批准后写回 `workspace-access.json`
- 再自动重放原始工具调用

命中白名单后，workspace 外路径按 `read/write` 能力执行，不再额外套入 workspace 内部的 `read/edit` pattern 规则。

### 决策 4：`ask` 通过现有 questionnaire mailboxes 落地

不新增审批 runtime。权限请求直接创建 `questionnaire_pending` 控制消息，并由现有 executor 恢复链继续处理。

## 兼容性

- 未提供权限配置文件时，系统保持 fail-closed 的保守默认值
- workspace 内访问也必须经过权限规则，而不是自动放行
- 针对 `bash`、`read`、`write`、`edit`、`multiedit`、`ls`、`glob`、`grep` 落地
- 所有带路径输入的读类工具都必须先做 `~/...` 归一化，再判权

## 风险

### 风险 1：`bash` parser 与真实 shell 语义不完全一致

策略：

- 覆盖常见 operator / redirection / env assignment
- 对 subshell / group / process substitution 等不可靠语法显式 fail-closed

### 风险 2：`ask` 与 tool result message 可能相互污染

策略：

- 用专用的“permission questionnaire pending”返回值
- 在 executor 中抑制该类 tool result message，只保留问卷流转
