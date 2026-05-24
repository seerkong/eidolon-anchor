# Acceptance: enhance-tui-scroll-and-selection-mechanics

## 目标

确认 prototype TUI 在历史滚动、边界跳转、文本选择和流式更新并存时，仍然保持稳定、可预测的交互行为。

## 验收范围

### In Scope

- 鼠标滚轮滚动
- 触摸板滚动
- 方向键滚动
- `PageUp` / `PageDown`
- `Home` / `End`
- 手动浏览历史时的流式更新
- 文本选择与滚动协调
- 输入区 / 历史区焦点切换
- bottom bar `History` / `Composer` 焦点切换

### Out Of Scope

- 消息卡片视觉改造
- command palette / status surface 功能本身
- composer 新功能

## 进入验收前提

- `codument validate enhance-tui-scroll-and-selection-mechanics --strict` 通过
- terminal TUI 测试可运行
- prototype 消息区具备足够长的历史和至少一段流式输出

## 自动化验收

### A1. Track 结构验收

执行：

```bash
codument validate enhance-tui-scroll-and-selection-mechanics --strict
```

通过标准：

- track 严格校验通过

### A2. TUI 自动化测试验收

执行：

```bash
bun run test:terminal:tui
```

通过标准：

- terminal TUI 测试通过
- 至少覆盖以下断言：
  - 鼠标滚轮滚动有效
  - 历史区在 composer 保留草稿时仍可恢复滚动
  - 空 composer 下方向键滚动有效
  - `PageUp` / `PageDown` / `Home` / `End` 行为稳定
  - 手动浏览时，流式更新不会强制跳到底部

## 手工功能验收

### M0. 启动方式

执行：

```bash
bun run dev:terminal:tui
```

使用带有长消息历史、可流式更新的 session。

### M1. 基础滚动点验

操作：

1. 使用滚轮向上/向下滚动
2. 使用触摸板向上/向下滚动
3. 在输入框为空时使用方向键
4. 使用 `PageUp` / `PageDown`
5. 使用 `Home` / `End`
6. 在输入框已有内容时点击历史区，再次使用方向键、触摸板或滚轮
7. 点击 bottom bar 中的 `History` / `Composer`，确认焦点切换与滚动语义一致

通过标准：

- 每种输入路径都能推动历史滚动
- 不出现明显跳帧、卡死或失控偏移
- 输入框有草稿时，点击历史区后仍可滚动历史
- bottom bar 焦点切换与区域真实行为一致，不出现“显示已切换但滚动/输入未切换”

### M2. 手动浏览与流式更新点验

操作：

1. 先滚离底部浏览历史
2. 在 assistant 继续流式输出时观察消息区

通过标准：

- 视口不会被错误强制拉回底部
- 用户仍可继续浏览历史
- 当用户主动回到底部后，自动跟底可恢复

### M3. 选择态点验

操作：

1. 在消息区选中一段文本
2. 观察同时发生的更新或滚动副作用

通过标准：

- 选择不会被轻易打断
- 不因无关副作用直接清空或破坏选择

### M4. 焦点可视反馈点验

操作：

1. 观察初始输入区聚焦时的颜色状态
2. 点击历史区
3. 点击 bottom bar 中的 `History`
4. 再点击回输入区
5. 点击 bottom bar 中的 `Composer`

通过标准：

- 输入区与历史区都能通过颜色变化显示当前焦点
- 底栏按钮与区域提示线一致反映当前活跃区域
- 切换焦点时不需要额外标签也能分辨当前活跃区域

### M5. 负面验收

以下任一情况都判定为不通过：

- 流式更新时频繁强制跳到底部
- PageUp / PageDown / Home / End 行为明显失控
- 选择文本时滚动或点击副作用直接破坏交互
- 当前已有 wheel / arrow scroll 行为发生回归
- 输入框有内容时，点击历史区仍无法滚动历史
- 输入框有内容时，历史区无法通过触摸板滚动
- 输入区 / 历史区焦点切换没有可见反馈
- bottom bar `History` / `Composer` 显示状态与真实交互目标不一致

## 验收记录要求

- 自动化测试命令与结果
- 手工点验覆盖的输入路径
- 观察到的终端差异或已知例外

## 最终通过条件

只有在以下条件同时满足时，本 track 才算功能验收通过：

1. `spec.md` 中全部场景被验证
2. 基础滚动路径无回归
3. 手动浏览与流式更新协调通过
4. 选择态与滚动协调通过
5. gap-loop 不再发现阻塞性缺口
