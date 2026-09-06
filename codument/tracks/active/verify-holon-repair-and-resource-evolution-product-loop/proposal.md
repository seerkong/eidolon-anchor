# 三入口 Holon 修复与资源演进的产品闭环

## 背景

已有独立 Task Runtime、owner-backed observation/repair、真实 OS effect 恢复，以及父 Data 图失败后修订下一 child Worker 的能力。现有测试部分只返回成功字符串；它们不能单独证明三入口的实际 Agent 配方一致、原业务产物成功或 provider 前缀稳定。

## 目标

- 一个实际 JSON 文件任务、一个独立 verifier，分别走独立 Holon、Ctrl、Data 的原生产执行链。
- 先以 RED 验证 standalone adapter 的 live Agent 配置、Effective VFS 冻结读取、旧版本任务恢复疑点，再在同一闭包内修复。
- 正式观察与修复入口完成停滞任务；Data 根据真实失败修订下一 child 的 Worker，原 verifier 验证收益。
- 记录真实产物、lineage、OS 恢复、effect 接受、配方/prefix/schema 与 usage 来源。当前零付费。

## 非目标

不创建第二 TaskSpace/GoalGraph/Agent store/Workflow；不扩大 capability catalog 语义；不改变 Ctrl 的控制图语义；不做全库职责重排。禁止用 test-only 正确配置掩盖生产 adapter 缺口，禁止把合成 usage 当远端命中率。manual；不 build/install/publish/commit，bun.lock 不入库。

## 修改范围

host 的资源 registry、Holon deployment/Bootstrap/Terminal execution adapter 中实证确认的窄接缝；产品测试/资源/本地 transport fixture；必要的文档。外部 halfcode/depa-flows 使用已批准 dirty baselines 的公开协议，发现外部缺口先回 Mission 受控重规划。
