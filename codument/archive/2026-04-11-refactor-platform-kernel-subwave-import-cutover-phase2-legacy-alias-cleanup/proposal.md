# 变更：平台微内核后续 sub-wave 的 import cutover phase2

## 背景和动机

phase1 已完成仓内内部 direct import 的 cutover。当前真正还留在日常开发路径解析层的旧命名残余，主要是各工作区 `tsconfig.json` 中的 legacy path alias：

- `@cell/organ-support`
- `@cell/mod-sys-kernel`
- `@cell/mod-sys-coding`

这些 alias 会继续给新代码提供“旧名字还能正常用”的错误暗示，因此需要在 phase2 中清理。

## 要做

- 创建 phase2 legacy alias cleanup track
- 删除工作区 `tsconfig.json` 中的旧 support/mod path alias
- 增加 focused guard，防止 legacy alias 回流

## 不做

- 本次不删除兼容 shim 包
- 本次不移除旧 package.json 包名
- 本次不处理 codument 历史文档中的旧命名

## 变更内容

- 让源码解析层只暴露新的 package host alias
- 收紧旧命名只存在于 compatibility package 本身
- 为后续是否删除 shim 提供更干净的基线

## 影响范围

- 受影响代码：
  - `cell/tsconfig.json`
  - `terminal/tsconfig.json`
  - `terminal/packages/tui/tsconfig.json`
  - `backend/tsconfig.json`
  - `cell/packages/organ-logic/tests/AIAgent/cell_package_surface_migration.test.ts`
  - `codument/tracks/refactor-platform-kernel-subwave-import-cutover-phase2-legacy-alias-cleanup/*`
- 与现有 track 关系：
  - 承接 `refactor-platform-kernel-subwave-import-cutover-phase1-internal-consumers`
  - 继续推进“旧命名只留在 compatibility layer，不再进入开发主路径”
