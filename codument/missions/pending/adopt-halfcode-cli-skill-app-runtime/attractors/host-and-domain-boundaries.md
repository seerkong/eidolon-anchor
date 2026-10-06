# AT1 结构与能力归属

> 本吸引子约束计划、决策、实现与校验。测试通过但违反排除集，仍按 drift 处理。

## 不变量

1. **单一上游 owner**：通用 Host 能力（命令协议、资源发现/准入、SOP、LocalFunction、Page/Site、bundle 加载、安装/打包）的源码 owner 是 `halfcode-cli-lite-*` 公共包。Eidolon 不维护同义的第二份实现。
2. **领域权威留在 Eidolon**：Effective VFS 准入、工作区写权限、Workflow session/实例冻结、执行状态与恢复，由 Eidolon 相应 owner 持有。公共 Host 不承担 Holon/Workflow 领域裁决。
3. **业务 App 不自授权限**：业务 Skill App 获得窄能力，不获得 arbitrary invoke/eval，也不通过 workspace 文件写入旁路准入。
4. **包依赖无环**：公共包不得 import Eidolon 领域包、硬编码 Eidolon 路径，或通过外部项目源码路径运行。可复用性由独立消费方证明，不凭 package.json 数量判断。
5. **恰好一个写入路径**：同一个目标事实的 live authority 只有一个。旧工具、新 Skill App 与动态函数调用同一 Processor，不按入口复制多套编排。
6. **版本化消费**：公共能力以已打包、可独立安装的版本化制品消费。源码存在、本地 pack、`.tmp` 候选都不等于已发行事实。

## 排除集

- 在 Eidolon 内复制一份通用命令注册 / 资源发现 / 材料加载 / bundle 构建以绕过公共包。
- 为让 Skill App「能跑」而在公共包中加入 Eidolon 特例（Holon/Workflow 领域判断、Eidolon 目录名）。
- 借 workspace 文件读写能力替代 VFS 准入；把 VFS 逻辑 URI 转成物理路径自行写入。
- 新增通用 `eval`/`exec`/万能 argv RPC 作为能力通道。
- 同一事实同时由 physical publisher 与 Effective VFS 独立裁决。

## 与项目既有吸引子的关系

本项目 `codument/attractors/project.md` 的 resource-native 与 Holon 自组织方向继续成立；本吸引子只补充跨仓归属维度，不取代它。depa-codument 的 `depa-host-boundaries` 吸引子是同构的外部参照，其已实施状态不作为 Eidolon 事实。
