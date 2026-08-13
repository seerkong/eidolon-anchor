# Building protocol

消费 coding 返回的 exact revision，校验引用、schema、function contract 和资源闭包。失败返回可定位 diagnostics 并回到 coding；成功转 testing，由 `WorkflowPreparePublication` 统一生成 canonical build receipt。不要重复 full-summary 或把 build prose 当作 proof。允许工具仅 workflow read/validate/build/status。
