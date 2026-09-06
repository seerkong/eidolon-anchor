# 运行反馈驱动下一子图的 Worker 准备

## 背景与目标

宿主已有 native select/create/revise-existing、durable resource publication、可跨进程恢复的 prepared Agent 与完整代码闭包。当前 WorkflowRuntimeService 只在 instance Prepared 时允许准备；真实父图的子图启动路径没有这一调用。因此不能把预先准备两个 Worker 的测试当成运行中自主升级。

本 Track 让父图控制器在目标 verifier 未通过后选择下一子图，子实例在自己的 Prepared 边界依据真实反馈选择、创建或修订 Worker，再冻结并执行，结果通过原 child owner 回流。父图和已启动旧 Worker 不解冻。

## 范围

- 复用原生 add-subflow、child identity/freeze/start/load/settle、Agent selection admission 及 Halfcode plan/apply/publication。
- 在资源声明的子图准备接缝中提供真实 candidate observation 和可信前次执行/验证事实；AI 产出原生 selection decision，不由宿主按目标关键字选择 Worker。
- 故障后的重复准备必须恢复相同 receipt/冻结代码；修改 live 资源不能改变已准备 Worker。
- 用真实 WorkflowRuntimeService 和本地模型响应替身验证 controller→child preparation→agent execution→verifier→结果回流；跨 OS 恢复仅靠持久材料。

非目标：GoalGraph、第二 TaskSpace/Agent store、任意动态 capability catalog、修改 parent frozen graph 的资源闭包、付费模型、构建安装发布提交。manual；bun.lock 不跟踪。

## 影响

主要接缝为 AIDataAgentResourcePreparation、WorkflowRuntimeService、AIDataWorkflowRuntimeDriver 及其资源声明/测试。通用协议如遇真实缺失应回到 depa-flows/Halfcode owner，不能在宿主复制通用 admission。
