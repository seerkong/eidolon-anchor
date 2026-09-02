# Design：Authoring candidate 与 Effective VFS 最终 CAS

## 现状与映射

| 旧步骤 | 新步骤 |
|---|---|
| `writeFileNoReplace(workspace/Agents/*.xnl)` 即暴露物理 bytes | 写入 durable workspace overlay intent，但 runtime 不读取该路径 |
| `loadResourceTree(workspaceRoot)` | 从 current Effective VFS 的唯一 Halfcode tree取得 catalog/kind planning authority |
| registry fence 重新扫描 layers | authoring transaction 请求 materializer 生成未发布 candidate read port |
| Halfcode refresh 后 registry 才承认 | candidate port完成 Halfcode readback和 receipt reconciliation后，materializer CAS admit；registry 接纳同一 revision |
| rollback 删除文件 | 删除未提交 workspace intent/journal；current VFS 与 parent closure保持原样 |

## 关键纠偏

G4 的 materializer 目前把“plan+validate+CAS”封装为一个方法，无法让 authoring-specific receipt validation 插入 CAS 之前。不能以“先 publish VFS、后验证 receipt、失败再回滚”代替原子性，因为其他 RuntimeConfig consumer 可能观察到短暂非法 revision。

因此本 Track先把 materializer 拆出 storage-neutral candidate handle：

1. `prepare` 从 immutable Builtin + 当前 overlays 构造 immutable candidate/read port 和 revision fence，不 publish；
2. Halfcode authoring runtime/registry 从 candidate read port完成 full readback；
3. `admit(candidate)` 校验 handle identity、current revision 与 authority revision，一次 CAS；
4. registry 只接纳该 admitted receipt对应 snapshot。

candidate handle 是进程内 capability，不能被结构复制伪造；durable journal保存可重建 intent而不保存 capability。

## 运行冻结

parent workflow snapshot 始终保留旧 revision。新 Worker 仅通过 authoring receipt + registry revision + preparation receipt进入新 task proof；provider prefix只在新 Worker epoch选择新 closure时变化。

## 并发与恢复

- 两个相同 current revision 的 proposal可并行 prepare，但只能一个 admit；另一个得到 CAS conflict并保留其可重规划 intent。
- crash 在 workspace intent 后、CAS 前：恢复 journal并重建 candidate。
- crash 在 CAS 后、receipt durable commit前：按 admitted revision和authority digest重建并幂等提交 receipt。
