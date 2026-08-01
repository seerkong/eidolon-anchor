# 变更：接入 TUI 输入与共享状态基础设施

## 背景

当前 prototype TUI 已经具备新的消息主链，但输入区、共享状态和文件选择仍然分散在几条未收敛的支线上：

- composer 仍主要停留在纯 textarea 交互，已有的 slash、mention、extmark、prompt history 素材尚未回到主链
- materials 相关状态仍部分依赖临时 state/navigation 桥，未来继续接入 system surfaces 会放大状态真相分裂
- frecency 素材已经沉淀，但缺少真正消费它的文件选择器

如果继续把这三部分拆成多个 track，输入链、状态底座和文件注入会长期互相等待，也会让后续 approval/history、system surfaces 和 command palette 的依赖图继续膨胀。

## 合并来源

- `add-tui-structured-composer-interactions`
- `refactor-tui-material-state-onto-depa-data-graph`
- `add-tui-file-picker-and-frecency`

## 变更内容

- 接入 slash、mention、文件/图片注入等结构化输入
- 将 extmark、prompt part 和 prompt history 恢复到新的 composer 主链
- 用 `depa-data-graph` 承载 materials 所需的共享状态，并将临时 bridge 降级为薄 adapter 或继续删除
- 将当前选择态并入 graph，把本地持久化偏好保留为外围 adapter
- 为 composer 增加文件选择器，并接入 frecency 对文件候选排序
- 将选中的文件插入为结构化 prompt part

## 影响范围

- 受影响的规范：`terminal-tui-shell`
- 受影响的代码：prototype composer、prompt parts、extmark 恢复、prompt history、prototype graph、materials state、navigation、file picker、frecency、prompt part 注入

## 顺序依赖关系

- 建议序号：`2`
- 建议前置：
  - `add-tui-coding-tool-part-cards`
- 建议后续：
  - `enhance-tui-approval-and-delegation-history`
  - `add-tui-system-management-surfaces`
  - `add-tui-research-tool-cards`
  - `add-tui-command-palette-surface`
- 说明：这个 merged track 同时承担输入主链、共享状态底座和文件注入能力，是后续 history/card/system surface 汇总的共同前置
