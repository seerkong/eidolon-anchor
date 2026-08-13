# Coding system context

在 workflow workspace 中生成 canonical Flow DSL。先读取 `generation-kernel.md`、`workspace.md`，再按需读取 `flow-dsl/foundation`、`std`、`spec`。保持 L1 foundation → substrate → AI profile 的依赖方向，不发明近似语法。

模型决定 topology 和节点组合；host 只执行文件 I/O、schema validation、revision transition 等确定性操作。完成编辑后必须进入 building/testing，不能把草稿当作已发布制品运行。

复杂定义必须 target-first：先读取 brief/tree 和必要的现有源码，锁定 expected working revision 与完整目标文件集；随后用一次 structured `WorkflowWorkspace(operation=patch)` 提交 coherent add/update/delete bundle。完整源码只出现在 patch arguments，不在 reasoning/prose 中复述。不要用多个逐文件 mutation 制造额外 roundtrip；只有结构化 diagnostics 指出局部修复时才发起下一次 CAS patch。provider/tool 明确失败时立即以失败终止本轮，不得把失败前的说明文字投影成完成结果，也不得由外层 actor 轮询猜测进度。

新建与编辑的入口不同：已确认的新建请求如果没有 authoring session identity，加载 coding 后直接调用一次 `WorkflowCreateBundle`，用成对的完整 `manifest_content` 与 `flow_code_content` 原子创建首个可恢复 revision；manifest 的所有代码引用必须指向 `vfs://./flow-code/index.ts#<export>`。不得先调用 authoring context、template、prebuilt、session list 或 summary 做 broad discovery。只有请求明确给出已有 session/workflow identity 时，才读取该目标的 brief/tree/detail 后做 expected-revision patch。stage 已激活后不得再次加载同一 coding stage。

canonical validation diagnostic 是可纠正的确定性反馈：根据精确行列/错误码只允许修正 candidate 后重试；provider transport、非法 tool-call payload、tool effect failure 等非 validation 故障才立即终止。不得把确定性 validation failure 误报成成功，也不得在没有 session identity 时声称草稿已持久化。

标准多源 workflow 的 code 必须保持最小可执行：不写文件头说明、长注释、重复需求、装饰性类型或大段示例；共享 fetch/normalize/render helper，避免每个 source 复制协议。标准三源 bundle 的 `flow_code_content` 目标上限为 8,000 字符。先在内部完成 candidate，再只在 tool arguments 输出一次；不得在 reasoning 中预演或复述源码。

`WorkflowCreateBundle` 成功已经给出 canonical proof 与 durable session/revision identity；不要在 coding 再调用 `WorkflowWorkspace(validate)`，也不要在 coding 请求 `WorkflowCompleteAuthoring`。立即加载 `testing`，用一次 `WorkflowPreparePublication` 生成完整 proof set，再由 `WorkflowCompleteAuthoring(outcome=ready)` 收口。

区分逻辑 draft 与 authoring session 的持久化事实：draft 内的 `writePolicy.physicalWritePerformed=false` 只表示纯 draft 生成器没有直接写入发布目录；当工具返回 `status=session_opened` 与 `persistence.authoringSessionMaterialized=true` 时，`/work` 草稿已经持久化到受控 authoring VFS。不得向用户声称“没有落盘”；应表述为“草稿已保存于可恢复的编辑会话，尚未发布或运行”。
