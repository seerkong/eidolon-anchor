# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】profile/capability contract 的宿主与组合路径
- 背景：项目中已存在 `mod-profiles`（profile 组合包）与 `ai-composer`（runtime 组合路径）。track 创建时影响范围未列入这两个包，存在实现时另起炉灶、形成第二个 profile 真相源的风险；而平台与领域两侧平行维护 registry/profile/bootstrap 真相源是项目明确的反模式。
- 选项：
  - A) profile/capability contract 与组合实现收敛到现有 `mod-profiles` + `ai-composer`，必要时在其上扩展
  - B) 新建独立的 profile/capability 包
- 最终决策：A
- 决策理由：复用现有组合路径符合 vendor/已有机制优先；新建平行包违反"profile 是唯一正式产品组合入口"的吸引子。实施第一步先盘点现有结构是否足以承载 binding descriptor，盘点结论记入 analysis 后再迁移 terminal entry。
- 状态：accepted
