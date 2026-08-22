# skill: codument-migrate（自主升级 Codument）

一次调用把目标收敛到当前 CLI Kind 版本。调用没有参数时升级整个 workspace；有一个资源路径时只升级该资源。`upgrade-workspace` / `upgrade-resource` 负责确定性发现、备份、转换和 receipt，当前 Coding Agent 负责 receipt 要求的语义 review。

## 路由

- `{{args}}` 为空：进入 **workspace 模式**，不询问迁移步骤。
- `{{args}}` 是一个文件路径：进入 **resource 模式**。
- 用户明确指定 workspace 目录时，在该目录运行同一流程。

`--agent` 只选择 skill 安装目标。迁移流程不传 `--agent codex`，也不通过 CLI 启动另一个 Agent；当前 Coding Agent 就是 review 执行者。

## Workspace 模式

1. 确认项目已初始化且 `codument` CLI 可用；记录当前版本和工作树状态。
2. 运行 `codument upgrade-workspace --json`。退出码 `2` 表示 receipt 中存在 `review-required`，仍须解析 stdout 并继续。
3. 重新打开升级后的 `codument/std/operations/migrate.md`，后续步骤以新 operation 为准。
4. 处理 receipt：
   - `semanticReviewRecommended`：对照 `backupPath` 与 `targetPath ?? path`，确认业务语义、未知字段和嵌套关系完整；需要修正时编辑当前 authority 并运行对应 validate。
   - `reviewRequired`：逐项进入“Resource review 循环”。
   - `cleanup.trackDirectoryConflicts`：检查冲突两侧 authority，升级各自资源并按 stable id、生命周期状态和业务内容确定唯一保留位置；无法证明时才 blocked。
5. 完成一项后继续下一项，不在单个资源或单个 Track 完成后返回。
6. 运行“Workspace 验证”。
7. 把 validate error 视为当前版本资源的语义 review 项，按 finding 指向的 authority 修正并重跑对应 validate；不能因 migration receipt 已稳定而忽略。
8. 再运行一次 `codument upgrade-workspace --json`。若仍有 review、semantic review 或 lifecycle conflict，回到第 4 步；receipt 稳定且验证通过后完成。

## Resource 模式

1. 运行 `codument upgrade-resource <path> --json`。
2. `upgraded`：根据 `backupPath` 和 `targetPath` 做语义复核，再运行对应 validate。
3. `noop`：运行对应 validate，确认当前 authority 已使用 CLI 当前 Kind 版本。
4. `review-required`：进入“Resource review 循环”。
5. `blocked`：按 diagnostics 解决可处理的外部前提；确实无法继续时返回明确 blocker。

## Resource review 循环

1. 读取 receipt、原 authority、`backupPath`、当前 KindDefinition/spec 与相关 registry。若 receipt 未给出 backup，先保持 blocked，不直接改写源 authority。
2. 让 CLI scaffold/serializer 创建版本与 Kind 匹配的目标骨架；AI 只补业务语义和 CLI 无法证明的映射。
3. 保留可证明的未知扩展、provenance、stable id 和嵌套关系；无法证明的内容形成明确 review issue。
4. Decision 迁移额外遵循 skill bundled reference `references/decision-migration.md`。
5. 对可由同一路径继续转换的资源，重跑 `codument upgrade-resource <path> --json`，直到 `upgraded|noop`。
6. 对 AI 才能完成的格式替换，先验证新 authority，再退役已备份的旧 authority；随后验证目标路径，并由 workspace 复扫证明旧文件不再被发现。

## Workspace 验证

按存在的资源域运行：

```bash
codument validate --strict
codument modeling validate codument/modeling
codument engineering validate codument/engineering
codument decisions validate codument/decisions
git diff --check
```

缺失的可选 registry 跳过对应命令。Track/Mission 本地 Decision 由全局 strict validate 覆盖；有独立 source set 时补跑 `codument decisions validate <path-or-owner-id>`。

## Review 原则

- 保留原文件、backup、migration manifest 与 structural fingerprint，直到新 authority 验证通过并可安全退役旧 authority。
- 旧资源没有 `apiVersion` 时先让 CLI 按结构尝试程序化升级。
- AI 按当前 spec 修正业务含义，Kind 版本、backup 和机械转换由 CLI 决定。
- Decision 保留 forest、嵌套 tree、options、answer feedback、证据和稳定 id；durable owner 使用业务目录。
- 未知字段、扩展节点和 provenance 无法映射时保留为显式 review issue。

## 完成与停止

只有同时满足下列条件才完成：最后一次 workspace receipt 不含 `reviewRequired`、`semanticReviewRecommended` 或生命周期冲突；目标资源全部处于当前版本；旧 authority 已退役；相关 validate 和 `git diff --check` 通过。

CLI 不可用、receipt 缺失必要 backup、语义归属无法证明或验证持续失败且没有可执行修复时返回 blocked，并列出资源、diagnostics 和已完成步骤。除此之外持续执行，不要求用户补充迁移流程。
