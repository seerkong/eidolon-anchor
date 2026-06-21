# 变更：平台微内核后续 sub-wave 的 import cutover phase3

## 背景和动机

phase1 已完成内部 direct import cutover，phase2 已完成 workspace legacy alias cleanup。当前旧命名残余已经只剩 compatibility shim 包本体：

- `cell/packages/organ-support`
- `cell/packages/mod-sys-kernel`
- `cell/packages/mod-sys-coding`

既然开发主路径已不再消费这些 shim，本轮应正式退休它们，避免工作区继续携带“旧名字仍然存在”的结构噪音。

## 要做

- 创建 phase3 shim retirement track
- 删除 legacy shim package 目录
- 更新 migration guard，要求 legacy shim package 已不存在

## 不做

- 本次不修改 codument 历史文档中的旧命名叙述
- 本次不归档此前各 sub-wave track
- 本次不处理仓外消费者兼容问题

## 变更内容

- 从 `cell/packages/*` 中移除旧 support/mod compatibility shim 包
- 将 focused test 从“兼容 shim 存在”切换为“shim 已退休”
- 收紧旧命名只允许留在文档历史与 guard 文本中

## 影响范围

- 受影响代码：
  - `cell/packages/organ-support`
  - `cell/packages/mod-sys-kernel`
  - `cell/packages/mod-sys-coding`
  - `cell/packages/organ-logic/tests/AIAgent/cell_package_surface_migration.test.ts`
  - `codument/tracks/refactor-platform-kernel-subwave-import-cutover-phase3-shim-retirement/*`
- 与现有 track 关系：
  - 承接 `refactor-platform-kernel-subwave-import-cutover-phase2-legacy-alias-cleanup`
  - 完成旧命名从开发主路径到物理工作区层面的退场
