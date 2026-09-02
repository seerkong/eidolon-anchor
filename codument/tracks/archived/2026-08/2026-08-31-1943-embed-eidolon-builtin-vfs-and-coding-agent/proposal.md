# Track: embed-eidolon-builtin-vfs-and-coding-agent

## Why

成熟 Coding Agent 的 Halfcode 定义目前由 `testkit/codument-proposition` 动态拼装，并把复制的 prompt bytes 写入被测 workspace `.eidolon/resources`。这使测试夹具成为事实上的生产资源 owner，也使没有物理 `.eidolon` 的编译产物无法解析同一 Agent。

## What

- 由 `@cell/mod-ai-coding` 持有正式 `.eidolon/resources` authoring tree，包含 AIAgentDefinition、Prompt、Workspace `AGENTS.md` MessageSource、Standard ContextPipeline、KindDefinitions 与工具引用闭包。
- 由确定性 generator 生成一个 full XNL VFS snapshot；所有目录与文件 node id 由 logical path 稳定派生，生成器不得随机分配 identity。
- source/dev 与 compiled runtime 都读取同一 canonical snapshot：source 读取受版本控制的生成制品，最终 Bun compile 通过 BunFS file assets 嵌入该制品。
- 公开一个只读 Builtin Eidolon VFS source/read port，供后续 overlay materializer 使用；consumer 不直接读取 authoring tree 或 BunFS blobs。
- proposition testkit 删除 copied production profile，只生成测试专属 Workflow/App，并引用正式 Coding Agent FQN。

## Non-goals

- 本 Track 不实现 home/workspace overlay materialization、atomic publish 或 Effective VFS current authority；这些属于 G4。
- 本 Track 不把 App registry、freeze/recovery 或 autonomous authoring 切换到 Effective VFS；这些属于 G5。
- 本 Track 不把 BunFS 变成资源语义 authority，也不在启动时随机重建 node identity。

## Acceptance

- 没有物理 `.eidolon` 时，source 与 compiled binary 都能从同一 Builtin snapshot 解析正式 mature Coding Agent。
- source/compiled 的 snapshot bytes、node ids、tree/content digest 与 Halfcode resource closure 完全相同。
- testkit 不再包含 Kernel/Coding prompt 的复制品，也不再为 CodeAgent 写一套平行定义。
