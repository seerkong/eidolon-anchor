# 变更：为 AI coding 工具增加本地权限控制

## 背景

当前本项目的 `bash`、`read`、`write`、`edit`、`multiedit`、`ls`、`glob`、`grep` 工具几乎没有正式的本地权限控制：

- `bash` 直接在 `shell: true` 下执行，没有按命令片段做 allow / deny / ask 判定
- 文件工具默认可访问 `workDir` 外绝对路径，也没有受控的 workspace 外目录白名单
- runtime 当前只有 network gate 和 plan approval gate，缺少对本地副作用的统一权限语义

这导致 coding tool surface 与已有 questionnaire / runtime gate 架构脱节，也给后续模块拆分带来困难。

## 变更内容

- 引入 home 级权限配置：
  - `~/.eidolon/permissions.json`
  - `~/.eidolon/workspace-access.json`
- 支持 `allow` / `deny` / `ask` 的本地权限规则
- 首批权限类别覆盖：
  - `*`
  - `bash`
  - `read`
  - `edit`
- 支持默认规则、按目录覆盖规则、wildcard pattern 与 `last-match-wins`
- 为 workspace 外路径访问增加按 workspace 声明的 `read/write` 白名单
- 对缺失 workspace 外目录白名单的访问，支持通过 questionnaire 授权并把结果写回 `workspace-access.json`
- 为 `bash` 增加 segment 级解析与判权
- 将权限 gate 接入 `bash`、`read`、`write`、`edit`、`multiedit`、`ls`、`glob`、`grep`
- 统一 `~/...` 路径解析语义，避免把 home 路径误当成 workspace 相对路径
- 将 `ask` 接入现有 questionnaire / suspend 流程，而不是引入平行审批机制

## 影响范围

- 受影响的规范：
  - `terminal-headless-runtime-cli`
  - `terminal-tui-shell`
- 受影响的代码：
  - `cell/packages/organ-logic/src/exec/AiAgentExecutor.ts`
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/*`
  - 新增本地权限配置 / 求值 / 文件路径守卫模块
  - `cell/packages/organ-logic/tests/AIAgent/*`

## 顺序依赖关系

- 建议序号：`1`
- 建议前置：无
- 说明：
  - 本 track 主要扩展现有 runtime/tool surface，不依赖新的 UI shell 能力
