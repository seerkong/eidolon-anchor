# skill: codument-archive-track（归档 Track）

归档完成或经用户明确确认终止的 Track。CLI 负责 behavior/modeling/engineering/decision registry transaction、冲突检测、rollback、目标路径、Track move 与条件 memory 提升；operation 只编排 hook、命令和语义复核。

## 主流程

1. 定位 Track，读取 `track.xnl`、proposal、design、reports 与未解决 Decision。
2. 执行 `operation-hooks.xnl` 中显式配置的 `archive-track:before` hook。
3. 运行 `codument validate <track-id> --strict`。结构或 registry 问题按 diagnostics 修正后重跑。
4. 对 completed Track 运行 `codument archive <track-id>`。只有用户明确同意归档非 completed Track 时才加 `--yes`。
5. 接受 CLI 返回的事务结果，不再人工重复 apply mutation、merge registry 或移动目录。
6. 执行显式 `archive-track:after` hook；其中的 ArtifactSync 按 `codument-artifact-sync` 处理。
7. 报告 archive 路径、晋升的 registry、跳过项、冲突和后续动作。

若当前 Track 是 Mission 子流程，归档结果和未完成 Track 的裁决都交还 MissionApplier；Mission 随后继续自己的完成判定与 ready operation，不把 archive 子流程收口当作 invocation 终点。

## Review-required

CLI 返回 `review-required` 时，读取保留的原 authority、migration manifest 与当前规范，完成语义转换后再次运行 `codument upgrade-resource <path>`、`codument validate` 和 `codument archive`。根 durable Decision 缺少业务 owner 时由 AI 选择有业务含义的 `codument/decisions/**` 路径，并保留完整 tree closure 与 provenance。

## 失败边界

- CLI 的校验、冲突和事务错误是需要处理的真实结果，不改走人工文件移动。
- 系统找不到 CLI 时归档保持 blocked，并说明缺失命令；不使用提示词模拟 registry transaction。
- Git 操作只在 Track 的 `commit_mode` 与用户授权允许时执行，不把提交当作归档成功的前提。

## 完成条件

CLI 成功、archive authority 可重新验证、显式 hook 已处理，且最终报告能对应实际文件和 registry 状态。
