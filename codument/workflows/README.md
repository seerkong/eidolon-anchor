# codument/workflows/ —— dynamic-workflow 流程的存放目录

本目录用于存放结构化 workflow 的 definitions 与 instances，布局与通用 workflow 规范保持一致：

```
workflows/
├── definitions/    预制可复用单元（AgentTaskDefinition / 类型包），与 dynamic-workflow 同格式
└── instances/      BTWorkflow 流程实例（process-instance.xml 等）
```

- 这里放的是**结构化、可被引擎执行的流程定义/实例**（`BTWorkflow` + `<Imports>`/`<Ports>`/`<Hook>`/`<TaskSpace>`/`<Extension>`），复用同一内核。
- 与 codument 自身：codument track（`track.xml`）的 `<TaskSpace>` 与这里 BTWorkflow 的 task-space **同构**，可互相引用/嵌入；codument 的 `cdt:` check 是内置节点类型（配置在节点上），dynamic-workflow 侧也可用同名 kind。
- **业务自定义的执行流程（文字/SOP 型）不放这里**——放 `codument/std/sop/`（见 `../sop/README.md`）。

> 具体 definitions/instances 按项目需要补充。
