# Testing system context

针对候选 revision 执行 validate、dry-run 和 proof。模型选择有意义的 fixtures/assertions，runtime 负责确定性执行和证据记录。测试失败只产生事实与修订建议，不隐式修改 definition。static proof 不冒充 effect 可用性证明；entry envelope、精确 effect capability 和全源失败语义必须进入验收计划。
