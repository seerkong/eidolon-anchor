# 逐文件隔离的重构基线

基线 27324a8。新增 cell/scripts/runtimeClosureRegression.ts，每个既有 Bun 测试文件独立 spawn，累计退出码，不共享模块 mock/registry。测试使用 TS 权威，不使用遗留 emit JS。目录以脚本位置解析；分组可选，默认完整矩阵。

Conversation 覆盖 raw state→Prompt/history、provider fact anchors/tool pairs、fork/rewind；ContextPipeline 覆盖 prefix/AGENTS/动态拼接；Holon 覆盖 accepted effect、真实文件、shared/fresh、独立与 Workflow 路由。使用现有真实 fixtures，不重造模拟系统。现有断言保持；失败先分析基线原因，不删用例。

提交 manual，阶段 GapLoop verify_round=true。modeling/engineering 项目配置关闭。无生产源码变化、无需新包或锁策略变更。
