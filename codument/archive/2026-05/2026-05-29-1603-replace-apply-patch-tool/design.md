# Design: Replace ApplyPatch Tool

## 上下文

本项目当前 `ApplyPatch` 是 TypeScript 实现，位于 `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/ApplyPatch/Logic.ts`。它已经支持结构化 patch envelope、Add/Update/Delete/Move、权限检查和 unified diff 输出，但它缺少 apply_patch 的几个关键 agent-safety 能力：真实 anchors、分层匹配、staged writes、安全 guard、read freshness/context refresh、丰富结构化输出和 prompt contract。


## 方案概览

1. Patch parser 与内部模型
   - 引入明确的 patch operation 类型：add/delete/update。
   - update operation 包含 `moveTo` 与 `hunks`。
   - hunk 保存：
     - `anchors: string[]`
     - `lines: PatchLine[]`
     - `endOfFile?: boolean`
   - `@@` 解析为 anchor；连续 `@@ ...` 在同一 hunk body 前累积为 ordered anchors。
   - patch envelope 必须非空，`*** End Patch` 后不得有非空 trailing content。

2. Hunk 匹配与应用
   - 实现 match modes：`exact`、`anchored_exact`、`normalized`、`fuzzy`。
   - anchor resolution：按 anchors 顺序搜索，找到最后一个 anchor 后从其下一行作为优先区域。
   - exact：无 anchor 时从 cursor 开始查找，可 wrap 到文件开头。
   - anchored_exact：有 anchor 时从 anchor region 开始查找，不随意应用到 anchor 之前。
   - normalized：按 `rstrip` 比较。
   - fuzzy：压缩 whitespace 后比较。
   - normalized/fuzzy 多候选时报错，避免猜测。
   - 每个 hunk 应记录实际使用的 match mode。

3. 文件落地机制
   - 先解析 patch 与权限检查，再构建 staged plan。
   - 对所有 operation 做 resolved path 去重。
   - Add：目标已存在则失败。
   - Delete：目标不存在或为目录则失败。
   - Update：源不存在或为目录则失败。
   - Move：目标存在则失败。
   - 全部校验与 hunk 应用计算成功后，再写入 staged writes 并执行 staged deletes。
   - 由于真实 filesystem 写入仍可能失败，错误输出需要保留失败信息；但设计上避免 parser/matcher/guard 阶段的半成功写入。

4. 权限与路径治理
   - 继续使用本项目 `resolveToolPath(workdir, path)` 解析 raw path。
   - 继续使用 `authorizeLocalToolCall(runtime, "apply_patch", { filePath })` 或等价本项目权限 gate。
   - 对 move 操作同时检查 source 与 destination。
   - 权限失败必须在任何写入前返回。

5. 输出兼容
   - 继续复用 `_file-editing.ts` 的 `buildMultiFileUnifiedDiff` 与 `encodeFileEditResult`。
   - 成功 payload 包含：
     - `message`
     - `ok: true`
     - `diff`
     - `touched_files`
     - `touched_files_absolute`
     - `added_count`
     - `updated_count`
     - `deleted_count`
     - `moved_count`
     - `match_modes_used`
     - `context_refresh_hint`
     - `invalidated_read_cache_entries`（若可用）
   - 失败 payload 包含：
     - `message`
     - `error: "patch_failed"` 或更细分 code
     - `detail`
     - `filePath`（单文件时）
     - `suggestions`

6. Freshness / context refresh 适配
   - 实现阶段先定位本项目是否已有 read-file cache、semantic context invalidation 或类似 runtime hooks。
   - 若已有：ApplyPatch 写前调用 freshness validation，写后 invalidate touched paths。
   - 若没有：至少返回 `context_refresh_hint`，并在设计/实现注释中标明 read cache invalidation 不可用。
   - 不为本 Track 大规模重写 runtime memory/cache，只做 ApplyPatch 所需最小适配。

7. Prompt contract
   - 更新 `Tool.detail.xnl`，说明：
     - 输入完整 patch envelope。
     - 支持 Add/Update/Delete/Move。
     - `@@` 可命名 anchor，推荐 `@@ def foo` / `@@ class Bar`。
     - 默认小 hunk，不要整文件旧块替换。
     - patch 失败后先 re-read 目标文件并缩小 hunk。
     - 普通文本编辑优先 ApplyPatch，不用 shell 模拟编辑。
   - 如本项目有 tool brief/prompt asset 生成机制，确保生成产物同步。

8. 测试策略
   - Parser tests：envelope、operation、anchors、malformed patch。
   - Matcher tests：exact、anchored_exact、normalized、fuzzy、ambiguous failure、nearest line diagnostics。
   - File operation tests：add existing reject、delete missing reject、delete directory reject、update missing reject、move onto existing reject、duplicate path reject。
   - Output tests：diff retained、metadata present、match modes recorded、context refresh hint present。
   - Permission/freshness tests：权限拒绝不写入；若 freshness hook 存在，验证 stale context 阻止写入和写后 invalidation。

## 影响范围与修改点（Impact）

- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/ApplyPatch/Logic.ts`
  - 主要替换 parser、matcher、apply flow。
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/ApplyPatch/OuterTypes.ts`
  - 评估是否保留 `patchText` 并可选兼容 `patch` alias。
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/ApplyPatch/Tool.detail.xnl`
  - 更新 tool contract 和使用指导。
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/_file-editing.ts`
  - 尽量只复用；若 metadata 类型需要扩展，可小改。
- 本项目测试目录
  - 增加 ApplyPatch 单元测试和必要 runtime 集成测试。
- 可能的 runtime/read cache 文件
  - 仅当项目已有相应机制时接入；否则不做大范围新增。

## 决策摘要

- 详见 `codument/tracks/replace-apply-patch-tool/decisions.md`。
- 当前关键结论：
  - 全量迁移 apply_patch 相关机制。
  - 成功输出保留 unified diff，同时新增结构化 metadata。
  - Track 使用 manual commit + final-phase yield-gap-loop。

## 风险 / 权衡

- 风险：fuzzy matching 可能误改。
  - 缓解：仅在唯一候选时使用；多候选 fail-closed；输出 match_modes_used。
- 风险：staged writes 不能保证 OS 级原子性。
  - 缓解：在 parser/matcher/guard 阶段避免半成功；真实写入异常仍结构化报告。
- 风险：本项目没有 read cache freshness 机制。
  - 缓解：实现最小 context_refresh_hint；若有可用 hook 再接入 invalidation。
- 风险：输出结构变化影响旧调用方。
  - 缓解：保留 unified diff 字段和现有 string JSON 输出形态。
- 风险：迁移范围过大导致一次 diff 难审。
  - 缓解：按 plan 分阶段：测试/模型与 parser/matcher/文件落地/prompt 与集成。

## 兼容性设计

- 输入兼容：优先保持 `patchText`，并评估支持 `patch` alias 以便 future parity。
- 输出兼容：保留 `diff` 与 `message`，新增 metadata 不删除旧字段。
- Tool 名称兼容：不强制把目录/工具名从 `ApplyPatch` 改为 `apply_patch`，除非本项目工具注册层需要；行为对齐优先于命名统一。

## 迁移计划

1. 补测试，锁定旧输出 diff 兼容和新机制预期。
2. 重构 ApplyPatch 内部模型和 parser。
3. 实现 anchor-aware matcher 与 match mode ladder。
4. 实现 staged file operation guards。
5. 集成权限、freshness/context refresh 和结构化输出。
6. 更新 tool prompt/detail。
7. 跑 targeted tests，完成 final gap-loop。

## 待解决问题

- 实现阶段确认本项目测试框架和 ApplyPatch 现有测试位置。
- 实现阶段确认是否存在 read freshness/cache runtime hook；若不存在，按最小适配处理。
