# Design

## 验收模型

最终验收不是重新实现，而是把四条已完成链路合成为一条可复现证据链：

```text
source product behavior
  -> native target lifecycle
  -> explicit architecture boundary
  -> executable local evidence
  -> compiled/installed entry evidence
```

## 验收层次

1. 静态 coverage：矩阵每一行必须绑定行为、target surface、架构边界 和测试。
2. 动态 component：authoring proof、publication/run confirmation、Material、Ctrl/Data runtime、GraphPatch/reuse 和 fresh-runtime recovery。
3. 人类入口：业务语言 corpus、`WorkflowFulfill`、kernel registry、CLI agent 和默认 business projection。
4. 分发入口：production builds、临时 install、installed binary help/smoke。
5. 独立裁决：fresh verifier 只读取目标和产物，实际复跑关键命令，issues-first 给出 PASS/GAP/BLOCKED。

## 失败处理

- 局部测试、surface 或 packaging gap 在本 track 内修复并复检。
- 如果发现产品协议或 authority 发生结构性偏移，保持 track ACTIVE 并把 evidence 返回 mission Reconciler，不用豁免掩盖。

## 决策摘要

- 以可执行 evidence 关闭矩阵，不接受实现者自述。
- 安装验证使用临时 target，证明 installer 和 installed artifact，而不覆盖用户全局二进制。
- 真正的模型调用只使用 Eidolon 自身 runtime/provider，不调用外部 agent CLI。
