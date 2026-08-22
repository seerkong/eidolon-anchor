# skill: codument-artifact-sync（制品同步）

同步用户指定或显式 hook 引用的一个 artifact。AI 负责选择业务内容和生成相对文件树；CLI 负责比较、冲突检测、写入与 rollback。

## 输入

- artifact id，或触发它的 `ArtifactSync { use = "..." }` hook；
- Track 的 output MaterialBundle；
- artifact 规则的 workflow、skill、attractor profile、targets 与 policy；
- docs 类制品所需的 modeling、engineering、behavior 和 provenance。

没有唯一 artifact id 时先澄清，不根据目录存在与否隐式同步。

## 主流程

1. 解析一个 artifact 及其 source、targets、policy；验证 source 确实属于 Track output MaterialBundle。
2. 读取生成内容所需的业务上下文。docs 类制品按 `std/attractors/model-driven-docs.md` 做内容选择、路由、质量和晋升判断。
3. 在 Track 的 staging 目录中生成一套完整相对文件树。多个 target 复用同一树，target-specific 差异必须来自 artifact 规则。
4. 对每个 target 先运行：

   ```bash
   codument artifact sync --source <staging-dir> --target <target-dir> --dry-run --json
   ```

5. 审查 create/update/unchanged 列表。存在覆盖时按 policy 或用户确认决定是否使用 `--force`。
6. 对每个已批准 target 运行同一命令去掉 `--dry-run`；需要覆盖时加 `--force`。
7. 验证所有 target 的文件集合、相对路径与内容；报告 artifact id、目标、变更和跳过原因。

文件型 target 使用只包含目标文件的 staging tree，再以目标文件所在目录作为 `--target`。web/command target 仍由其明确 workflow 处理，不伪装成本地目录同步。

## 失败边界

- CLI conflict 保留 target 原状；先解决 policy 或取得确认再重试。
- 任一 target 失败时报告该目标和已成功目标，不生成另一套内容绕过冲突。
- 系统找不到 CLI 时写入阶段保持 blocked；可以完成内容草稿，但不手工复制 staging tree。
- ArtifactSync 只由用户或显式 hook 触发，不因 docs/memory profile enabled 自动运行。

## 完成条件

staging 内容通过语义 review，所有批准 target 的 CLI sync 成功，输出树一致，且最终报告与实际文件相符。
