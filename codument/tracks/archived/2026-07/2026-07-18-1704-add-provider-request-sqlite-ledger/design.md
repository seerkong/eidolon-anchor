# Provider Request SQLite Ledger Design

## 上下文
History 是领域审计真源，但不是实际 provider request 的现场副本。观测必须在真实 provider attempt 之前完成，并与 History persistence 解耦。

## 方案概览
1. Contract
   - 定义不可变 `ProviderRequestObservationData`，包含 schema version、session/actor/turn/provider-call/attempt identity、provider/model/adapter/driver、capture layer、时间、messages/tools/request contract 副本、摘要与 digest。
   - provider-specific Data/Port 定义在 `ai-organ-contract`；不进入 `ai-core-contract`，append 不返回业务结果。
2. Runtime logic
   - `ProviderRuntimeLlmAdapter` 分配 logical provider call 与 retry attempt identity，并把 typed wire observer 传入 driver/transport。
   - 低层 adapter 在所有确定性变换完成后、每个真实 `fetch` 或 WebSocket `send` 前生成 transport observation；WS fallback 作为同一 provider attempt 下的新 transport attempt。
   - 仅复制和递归脱敏 observation 数据；原始 request 参数保持引用和结构不变。
   - port 异常被捕获为有界 observability diagnostic，provider 调用继续。
3. SQLite support
   - app 顶层 `terminal/organ-support` 使用 `bun:sqlite` 实现 Effect，写入 `sessions/<id>/observability/provider-requests.sqlite`。
   - 使用 WAL、schema version、append-only provider/transport attempt 表和有序 source-message 表；事务内完成一次 transport attempt 写入。
   - 文件权限 0600，close/checkpoint 属于 runtime dispose 生命周期。
4. Terminal composition
   - `--capture-provider-requests` 只选择 capability；`organ-support` 构造不透明 binding factory。
   - `terminal/organ` 的 runtime config 接收 factory，在 sessionDir 已知后取得 `{ port, dispose }`，并把 port/identity 传给现有 runtime adapter factory；不读取 messages/body、不写 SQL。
   - 保持依赖 `cli -> organ-support -> organ -> ai-organ-logic -> ai-organ-contract`；`organ` 禁止 import `organ-support`。
5. Verification
   - fake driver 验证 retry identity；transport 测试验证普通 HTTP、WS continuity/tool-output 重写、WS 失败后的 HTTP fallback 都在真实 send 前记录最终 body。
   - SQLite 验证 reopen/query、WAL/schema、redaction、0600。
   - 恢复目标 session 后查询连续请求的 message role/tool pair/projection 顺序。

## 影响范围与修改点（Impact）
- `cell/packages/ai-organ-contract`：provider-specific typed observation contract/port；`ai-core-contract` 不新增该类型。
- `cell/packages/ai-organ-logic`：attempt capture、redaction、diagnostic isolation。
- `cell/packages/ai-organ-logic/src/runtime/ShellRuntimeSupport.ts`：显式 runtime observation binding。
- `terminal/packages/organ-support`：`bun:sqlite` Effect、binding factory 与 headless option。
- `terminal/packages/organ` / `terminal/packages/cli`：能力选择、session lifecycle wiring 与 CLI flag。

## 决策摘要
- SQLite 只对 captured diagnostic observations 负责，不是 domain truth。
- 完整内容采集默认关闭，目标 session 验证时显式开启。
- terminal/organ 不拥有请求观测语义、脱敏逻辑或 SQLite 实现，只负责 app composition 注入和 lifecycle。

## 风险 / 权衡
- 完整 messages 可能包含业务敏感内容：显式开关、0600、认证字段脱敏，并在输出中提示数据库敏感。
- 同步 SQLite 写入增加少量调用延迟：单事务、WAL、预编译语句；失败立即 fail-open。
- provider body 含动态 continuation/cache 字段：以 fetch/WebSocket send 入参为准；observation 是脱敏后的 exact request body，不声称是包含认证 headers 的逐字节 wire payload。

## 兼容性设计
- observation port 缺省为空，现有 adapter 行为与调用次数不变。
- factory override/mock adapter 不强制实现 ledger；真实 provider runtime adapter 路径覆盖现场验证。

## 待解决问题
- 无。
