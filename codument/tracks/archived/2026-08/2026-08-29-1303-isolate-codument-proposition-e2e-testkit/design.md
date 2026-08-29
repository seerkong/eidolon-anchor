# Design: isolate-codument-proposition-e2e-testkit

## Ownership boundary

新增仓库级私有目录 `testkit/codument-proposition/`，它不是 workspace 发布包，也不进入任何生产 package 的 `exports`。目录内部保持现有分层，但分层表达的是测试设施的职责，不再冒充产品 contract/logic/support：

- `contract.ts`：命题 manifest、mode、receipt、port 与 effect runtime 类型。
- `harness.ts`：manifest/identity 校验、canonical digest、cell 执行与 receipt 生成。
- `matrixRunner.ts`：三模式矩阵规划和有界调度。
- `support.ts`：Eidolon ordinary/Ctrl/Data 真实入口投影、环境白名单、receipt store 与 workflow fixture。
- `liveRuntime.ts`：可执行 epoch 绑定、source manifest、进程运行与 provider turn 事实提取。
- `index.ts`：仅供仓库测试和脚本使用的统一入口。

这些模块保持单向依赖：`contract <- harness <- matrixRunner`，terminal-oriented `support/liveRuntime` 可引用前三者与生产 runtime；任何生产 `src` 不得反向引用 testkit。

## Migration and compatibility

迁移是所有权移动而非行为重写。先用现有测试和专用 typecheck 固化：

- manifest/receipt 的 canonical 字节与 digest；
- ordinary、AI Ctrl、AI Data 的 mode identity；
- provider attempt/turn、cache usage 与 executable epoch 证据；
- registered Workflow XNL fixture 的内容与入口 argv；
- runner 从任意外部 cwd 启动时不依赖 workspace package alias。

迁移后只更新仓库内部 imports；不提供生产兼容 re-export。因为相关文件尚未形成已发布产品 API，保留 compatibility shim 反而会固化错误边界。

## Source conformance ratchet

新增测试扫描生产包 `src/**/*.ts` 与公开入口：

- `cell/packages/ai-organ-contract/src/index.ts` 不导出 proposition E2E；
- `cell/packages/ai-organ-logic/src/index.ts` 不导出 proposition E2E；
- `terminal/packages/organ-support/src/index.ts` 不导出 proposition support/live runtime；
- 生产 `src` 不出现 `testkit/codument-proposition` 或旧 `*/e2e/CodumentProposition*` imports；
- 旧生产路径不存在。

## Preserved product evidence

本 Track 只迁移测试命题私有类型和执行设施。Provider cache、Workflow public runtime、Conversation/epoch 等生产 evidence authority 不变；testkit 继续通过公开生产能力观测它们，不创建第二份产品 authority。

## Verification

- Bun：harness、matrix runner、terminal proposition support/live runtime 测试。
- TypeScript：`cell/tsconfig.codument-proposition-e2e.json`。
- Source conformance：旧路径、公开导出、生产反向依赖扫描。
- `codument validate <track> --strict` 与 `git diff --check`。
