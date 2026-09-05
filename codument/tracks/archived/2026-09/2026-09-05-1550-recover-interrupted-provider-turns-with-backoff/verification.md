# 验收与交付 — 2026-09-05

## 结论

本 Track 范围实现完成，fresh AttractorCheck 第二轮 NO_GAP；已构建并本地安装。未发起付费 provider 请求、未操作用户原 session、未自动 Git commit。

## 证据与纠偏

1. RED：虚拟时钟首请求 121 秒后 socket close，旧实现仅调用一次；9 个预算/取消回归先失败，修复后预算测试 42 项 / 166 断言通过。
2. RED：真实 ingress 的 streaming/cooperative 中断恢复失败；仅重建 parser 后，canonical 仍出现 `FAILED_CONTENT_FRAGMENTsuccessful content`。新增显式 provider attempt 事务边界，成功才通过原历史单写者提交，失败丢弃；补测交错 actor、过期 terminal、旧 assembly state、delta 合并。
3. fresh 审查第一轮 GAP：transport owner 对 semantic-only 错误多发 retry_filtered，导致原诊断数量翻倍。已排除两类 semantic owner 的 transport 诊断，原 executor 回归通过。
4. 缓存产品矩阵发现上层重试把一轮观测拆成两次 call。local-only callToken/attemptNumber 与 adapter WeakMap 保持逻辑 call identity，不向 wire 写入字段。产品闭合矩阵与 executor 联合 72 项 / 343 断言通过。
5. 取消语义明确化：请求前已取消时零发送、零 transport observation；实际请求开始后取消仍且仅记录一次 aborted outcome。两观察文件 22 项 / 133 断言通过。
6. 会话诊断回读验证 actor、operation、attempt、分类、等待预算及终止原因；不写原始错误正文；logs=false 不创建日志。

## 独立复核

Fresh reviewer `/root/attractor_review_final` 完整阅读 `codument/attractors/project.md`、设计、behavior delta 与改动，独立运行相关 13 个测试文件：183 tests / 795 assertions，0 fail，`git diff --check` 通过，结论 NO_GAP。验证覆盖预算、取消、两个执行器、历史隔离、wire 隐私、重试归属、传输观测及语义恢复。

## 全量回归与既有边界

`bun test cell/packages/ai-organ-logic/tests/AIAgent --timeout 30000`：1411 pass / 2 skip / 4 fail，7041 断言，187 文件，124.44 秒。

四项失败均在从 HEAD `f28c0d6fb0e4a2f8971e86c37d229b5e5bf29752` 导出的独立源码副本（使用当前同一依赖环境）复现相同断言，不属于此次改动：

- `detached_actor_tasks_registry_and_completion.test.ts:155`：下一轮缺 delegate summary。
- `delegate_delivery_incident_regression.test.ts:313`：未找到包含 childDone summary 的请求。
- `delegate_actor_child_done.integration.test.ts:111`：sync_wait 缺 parent done。
- `organization_tools.test.ts:483`：旧期望 HolonTaskTarget，与现状 HolonTaskRuntimeDefinition 不符。

不宣称全项目全绿。以上问题留作独立治理，不扩大本次 provider 修复范围。

TypeScript `cell/tsconfig.json` noEmit 对照：HEAD 源码 37 条诊断、当前源码 37 条，新增 0；修改源码无诊断。使用同一 CompilerHost，仅为基线替换本次改动文件的 HEAD 内容，保持模块解析路径一致。既有全项目类型债务未掩盖或清理。

## 构建与安装

- `PATH=/Users/kongweixian/.bun/bin:$PATH bun run build:terminal:tui` 成功，系统 skill plan 检查通过。
- `bun run install:dist:terminal` 成功，更新 `~/.local/bin/eidolon` 到本项目构建产物的既有 symlink，并安装 native runtime。
- 安装后 `eidolon --help` 成功。
- 构建与安装入口 SHA-256 一致：`9e3c827cf284faf01770a1d00c2bcad6be0d1cd8734df4d22086fb181afd97c1`。

## 归档约束

manual commit，不提交。Modeling/Engineering 配置关闭，无相应 delta。Track 无 output MaterialBundle；旧 archive:after/docs artifact 配置不能推导出本 Track 的唯一有效 source，因此无 docs 写入。仅按 CLI 事务归档并提升两个 behavior delta。不能据离线故障注入宣称中转服务本身恢复稳定。
