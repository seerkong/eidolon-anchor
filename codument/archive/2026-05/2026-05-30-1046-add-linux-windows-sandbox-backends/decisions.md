# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】Linux backend implementation depth
- 背景：Codex Linux 默认使用 helper + bubblewrap + seccomp，legacy Landlock 只作为显式 fallback。本项目是 TypeScript/Bun 项目，不能直接复用 Rust crate。
- 需要决定：Linux backend 首版应做到哪一层。
- 选项：
  - A) 实现 helper-style wrapper，优先调用系统 `bwrap`，并在 helper stage 加入 seccomp/no-new-privs 能力或明确缺失错误。
  - B) 只实现 `bwrap` command builder 和 dependency check，网络/其它限制缺失时返回 unsupported。
  - C) 其他（可填写）
- 当前建议：A，但允许分阶段落地：先用测试锁定 command builder，再补平台 smoke 与 helper 能力。
- 用户答复：执行实现。
- 最终决策：采用分阶段 A/B 组合：本 track 实现系统 `bwrap` command builder 与 runtime adapter，保留 helper/seccomp 深化为后续平台增强。
- 决策理由：当前 TypeScript runtime 可以可靠扩展 selection、writable roots、protected metadata 和 network namespace 参数；缺少目标 Linux helper 打包链时，不引入不完整 native helper 更稳妥。
- 状态：decided

### 2. 【P0】Windows elevated setup scope
- 背景：Codex Windows sandbox 依赖 elevated setup、sandbox users、ACL、capability SIDs、runner IPC 和网络过滤。完整移植成本高，且需要 Windows 目标环境验证。
- 需要决定：Windows backend 首版是否实现完整 elevated setup。
- 选项：
  - A) 按 Codex Elevated 原理实现 setup-aware backend；setup 未完成时明确报错，不降级。
  - B) 首版只实现 restricted-token/ACL command planner 和 setup readiness 检查，真实 elevated runner 留到后续 track。
  - C) 其他（可填写）
- 当前建议：A，计划中拆成 readiness/setup contract、command runner adapter、platform-gated smoke test，避免一次性大爆炸。
- 用户答复：执行实现。
- 最终决策：采用 setup-aware runner adapter contract：runtime 分派到 `eidolon-windows-sandbox-runner`，并通过 args 表达 cwd、mode、network、writable roots 与 protected metadata deny-write；真实 elevated setup/runner 二进制保持外部依赖。
- 决策理由：完整 Windows elevated 用户、ACL、capability SID 和 runner IPC 需要 Windows 目标环境与管理员 setup 流程验证；本 track 先消除隐式 unsandboxed fallback，并把安全边界收敛到明确 runner contract。
- 状态：decided

### 3. 【P1】Dependency packaging strategy
- 背景：Linux 可能需要 `bwrap` 或 bundled helper，Windows 可能需要 helper binaries/setup artifacts。本项目当前没有跨平台 sandbox helper 打包约定。
- 需要决定：依赖缺失时的行为和打包边界。
- 选项：
  - A) 首版要求系统依赖/外部 helper 存在，缺失时报 actionable error。
  - B) 首版把 helper/bwrap 打包进项目发行物。
  - C) 其他（可填写）
- 当前建议：A，避免在安全敏感功能里先引入不完整打包链；后续可单独 track 做 bundled helpers。
- 用户答复：执行实现。
- 最终决策：首版要求系统/外部 helper 存在。Linux 默认调用 `bwrap`，Windows 默认调用 `eidolon-windows-sandbox-runner`，也支持环境变量覆盖。
- 决策理由：缺失依赖会在 sandbox backend 执行路径中失败并返回错误，不会降级到 unsandboxed；打包 helper 可作为独立 track 处理。
- 状态：decided

### 4. 【P1】Network restriction strictness
- 背景：`network_access=disabled` 不能在 Linux/Windows 上静默允许网络，否则会破坏 sandbox 语义。
- 需要决定：当平台网络限制能力不可用时如何处理。
- 选项：
  - A) fail closed，返回明确错误。
  - B) degrade with warning，继续执行 filesystem sandbox。
  - C) 其他（可填写）
- 当前建议：A。
- 用户答复：执行实现。
- 最终决策：fail closed，不做 warning degrade。
- 决策理由：Linux `network_access=disabled` 映射为 `bwrap --unshare-net`；Windows 将 network policy 传递给 elevated runner adapter。若底层 helper/runner 不支持或不可用，执行失败且不会走 unsandboxed。
- 状态：decided
