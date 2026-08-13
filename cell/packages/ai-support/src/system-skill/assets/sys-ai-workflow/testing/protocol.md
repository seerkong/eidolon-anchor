# Testing protocol

读取测试计划，在最后一次 mutation 后只调用一次 `WorkflowPreparePublication({session_id})`，由 component 按 `diff → canonical validate → non-effectful static projection → build → acceptance disposition` 产生完整 exact-revision receipt set。acceptance disposition 由 component 从 canonical profile/manifest 派生；不得由模型提交 acceptance policy、根据用户是否允许真实运行来猜 disposition，或自行编造 policy source。失败回 coding 生成新 revision 后重新 prepare；成功后直接调用 `WorkflowCompleteAuthoring(outcome=ready)`，不要先读 summary、重跑 proof 或用模型 prose 自报完成。

测试输入必须遵守 `FlowContract` 的精确 entry port envelope：例如 `inputPorts = ["input"]` 时实例输入是 `{ "input": { ...业务输入... } }`，不能把业务字段或空对象直接当作 entry port map。static dry-run 只证明 definition/binding，不证明外部 effect 真正可用；包含 effect 的 workflow 在发布前还必须逐项核对 operation 是否属于 coding capability contract，并设计最小运行验收。

多源外部采集至少覆盖：单源失败仍按声明降级；所有必需源失败时 workflow 进入 `Failed` 且不产出伪报告；至少一个成功路径产出满足 output contract 的业务结果。canonical authority 要求发布前 candidate acceptance 时，只消费 component 选择的已安装 isolated fixture identity；不得把测试输出或真实网络结果塞入模型自报 policy。允许工具仅 workflow read/prepare-publication/complete-authoring/status；真实运行验收移交 deploying/operating 阶段执行。
