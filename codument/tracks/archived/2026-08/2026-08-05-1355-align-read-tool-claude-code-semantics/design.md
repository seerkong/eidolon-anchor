## 上下文

本 track 是 mission `improve-file-read-efficiency-and-context-reuse` 的 G2 落地 track，负责把 `read` 工具行为对齐 Claude Code Read 语义并补齐文件元信息。可见性判定（compacted 引用）由 G3 track 处理，配置参数化由 G4 track 处理。

## 方案概览

1. 统一默认并实现大文件截断（[Read/Logic.ts](cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Read/Logic.ts)）
   - 文件读取默认 `limit=2000`、`offset=1`（现状已是）。
   - 目录默认从 200 改为与文件一致（2000），消除双默认。
   - `>2000` 行文件结合 offset/limit 截断到前 2000 行，不再整文件进入上下文。
   - 截断行为对齐 Claude Code：截断正文不带每行行号。
2. header 增加 `total-lines` 元信息（[LocalTextResourceLoader.ts](cell/packages/ai-organ-logic/src/runtime/LocalTextResourceLoader.ts)）
   - `<context-resource>` header 增加 `total-lines="<N>"` 属性。
   - 文件与目录通用；already-visible 引用也保留 total-lines。
   - 与现有 `revision` / `requested-lines` / `delivered-lines` 属性风格一致。
3. 文件大小/行数元信息（方向 C）
   - 在读取前提供文件 size / 总行数元信息（read 输出或 ls 目录工具）。
   - 与 total-lines header 保持同一语义，避免另一套隐式逻辑。

## 影响范围与修改点（Impact）

- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Read/Logic.ts`
- `cell/packages/ai-organ-logic/src/runtime/LocalTextResourceLoader.ts`
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Ls/`（如采用 ls 元信息方案）
- 相关 read / loader 测试

## 决策摘要

- 详见 `decisions.xnl`。
- read 对齐 Claude Code Read 语义（选项 1），不改 Codex 强制 range。
- `total-lines` 作为 `<context-resource>` header 属性（决策 A）。
- 截断不带行号，对齐 Claude Code（决策 B）。
- 目录也加 total 元信息并统一默认（决策 C）。
- 方向 C：先提供文件 size/行数元信息再决定读取范围。

## 风险 / 权衡

- 风险：截断后正文不带行号，可能影响 edit/apply_patch 定位。
  - 缓解：edit/apply_patch 使用精确片段匹配而非行号；截断只影响超 2000 行的大文件，模型仍可翻页读取目标片段。
- 风险：total-lines 与 ls 元信息两套入口语义漂移。
  - 缓解：本 track 明确 total-lines 与文件 size/行数共用同一 source，单一事实源。

## 待解决问题

- 文件元信息入口最终落在 read header 还是 ls 工具（或两者），实现时按 P2 任务确认。
