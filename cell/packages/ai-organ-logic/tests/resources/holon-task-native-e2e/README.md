# 原生组织样例

此目录由公共合成 fixture、OrganizationChangeSet 和 File-XNL issuer 生成。组织记录使用原生对象、数组字段，authoritative head、records、tree、receipt 由公共包管理。

在 `cell/packages/ai-organ-logic` 运行 `bun run check:holon-e2e-resource` 校验逐字节再生成；生成时为 `bun run generate:holon-e2e-resource --output <已创建的空绝对目录>` 提供独立输出目录。

相邻 `holon-task-e2e` 是历史兼容样例，其原始字节保持不变。快照及发行证明中的 base64 资源信封承载 exact bytes，不能用编辑信封替代组织提交。
