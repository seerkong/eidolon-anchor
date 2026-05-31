import { describe, expect, it } from "bun:test"
import fs from "fs"
import path from "path"

const tuiSrcRoot = path.resolve(import.meta.dir, "../src")
describe("TUI help copy", () => {
  it("mentions the new slash-command namespaces in help surfaces", () => {
    const help = fs.readFileSync(path.join(tuiSrcRoot, "ui/dialog/help.tsx"), "utf-8")
    const tips = fs.readFileSync(path.join(tuiSrcRoot, "ui/primitives/tips.tsx"), "utf-8")
    const composer = fs.readFileSync(
      path.join(tuiSrcRoot, "app/tui_a1/features/composer/composer.tsx"),
      "utf-8",
    )
    const bottomBar = fs.readFileSync(path.join(tuiSrcRoot, "app/tui_a1/bottom-bar.tsx"), "utf-8")
    const tuiA1View = fs.readFileSync(path.join(tuiSrcRoot, "app/tui_a1/view.tsx"), "utf-8")

    expect(help).toContain('/actor')
    expect(help).toContain('/member')
    expect(help).toContain('/holon')
    expect(help).toContain('使用说明')
    expect(help).not.toContain('焦点:历史')
    expect(help).not.toContain('焦点:输入')
    expect(help).toContain('/status')
    expect(help).toContain('/shortcuts')
    expect(help).toContain('菜单')
    expect(help).toContain('Tip of the moment')
    expect(help).toContain('shift+enter')
    expect(help).toContain('ctrl+shift+l')
    expect(help).not.toContain('alt+enter')
    expect(help).not.toContain('bottom bar 使用说明')

    expect(tips).toContain('/actor assign')
    expect(tips).toContain('/member create')
    expect(tips).toContain('/holon assign')
    expect(tips).toContain('bottom bar')
    expect(tips).toContain('会话')
    expect(tips).toContain('使用说明')
    expect(tips).toContain('菜单')
    expect(tips).toContain('shift+enter')
    expect(tips).not.toContain('alt+enter')
    expect(tips).not.toContain('Click {highlight}使用说明{/highlight} in the bottom bar')
    expect(tips).not.toContain('/share')
    expect(tips).not.toContain('/undo')
    expect(tips).not.toContain('/redo')
    expect(tips).not.toContain('Build and Plan agents')

    expect(composer).toContain("approval required before submit")
    expect(composer).toContain("selectionLabel")
    expect(composer).toContain("theme.textMuted")
    expect(composer).toContain("shift+enter newline")
    expect(composer).not.toContain("alt+enter newline")
    expect(bottomBar).toContain("BusyBeacon")
    expect(bottomBar).toContain('会话')
    expect(bottomBar).toContain('Actor')
    expect(bottomBar).not.toContain('使用说明')
    expect(bottomBar).toContain('菜单')
    expect(bottomBar).not.toContain('焦点:历史')
    expect(bottomBar).not.toContain('焦点:输入')
    expect(tuiA1View).toContain('tok')
    expect(tuiA1View).toContain('本轮')
    expect(tuiA1View).toContain('峰值')
    expect(tuiA1View).toContain('使用说明')
  })
})


it("explicitly owns alternate screen and mouse tracking for in-app scrolling", () => {
  const tuiA1Entry = fs.readFileSync(path.join(tuiSrcRoot, "app/tui_a1/launcher.tsx"), "utf-8")
  expect(tuiA1Entry).toContain("useAlternateScreen: true")
  expect(tuiA1Entry).toContain("useMouse: true")
  expect(tuiA1Entry).toContain("exitOnCtrlC: true")
  expect(tuiA1Entry).not.toContain("installTerminalScrollContainment")
  expect(tuiA1Entry).not.toContain("disableStdoutInterception()")
  expect(tuiA1Entry).not.toContain("console.log(JSON.stringify(route.data))")
})
