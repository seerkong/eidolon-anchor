# 变更：中断的 Provider turn 有界恢复

## 背景和目标
现场4次Bun socket close均retryable=true但停止，具体终止原因未持久化。确定性复现首请求121秒便耗尽默认120秒预算。旧规范另禁止部分思考/文字后的恢复，即使尚无工具副作用。
目标：长首请求不占退避预算，Chat预派发turn能指数退避重新生成并记录原因，取消/期限/次数仍有界。

## 变更和非目标
BREAKING：放宽已确认预派发的上层Chat turn恢复；低层默认仍禁止拼接部分输出。修改ProviderErrors、runtime adapter与executor共享完成边界、诊断和测试。
不绑定provider名、不无限重试、不重放已执行工具、不改变成功Prompt、不修改真实session，不扩展Responses服务器工具恢复、不付费调用。

## 授权
用户已同意前轮方案并要求创建、落地、归档，作为实施批准。manual提交，自动测试和最终fresh方向审查，不再次逐文件确认。构建本地安装后归档。Modeling/Engineering配置均disabled。
