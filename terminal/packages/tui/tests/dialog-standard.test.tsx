/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount, type JSX } from "solid-js"
import { ArgsProvider } from "../src/providers/args"
import { ExitProvider } from "../src/providers/exit"
import { KVProvider } from "../src/providers/kv"
import { KeybindProvider } from "../src/providers/keybind"
import { RuntimeClientProvider } from "../src/providers/runtime-client"
import { ThemeProvider } from "../src/providers/theme"
import { SyncProvider } from "../src/app/tui_a1/state/sync-context"
import { DialogProvider, useDialog } from "../src/ui/dialog/context"
import { DialogAlert } from "../src/ui/dialog/alert"
import { DialogConfirm } from "../src/ui/dialog/confirm"
import { DialogExportOptions } from "../src/ui/dialog/export-options"
import { DialogHelp } from "../src/ui/dialog/help"
import { DialogPrompt } from "../src/ui/dialog/prompt"
import { DialogSelect } from "../src/ui/dialog/select"
import { ToastProvider } from "../src/ui/toast/toast"
import { DialogSessionRename } from "../src/app/tui_a1/system/session/session-rename-dialog"

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

function OpenDialogOnMount(props: { render: () => JSX.Element }) {
  const dialog = useDialog()

  onMount(() => {
    dialog.replace(props.render)
  })

  return <box width="100%" height="100%" />
}

function renderDialogHarness(render: () => JSX.Element) {
  return (
    <ArgsProvider>
      <ExitProvider onExit={async () => {}}>
        <KVProvider>
          <ToastProvider>
            <RuntimeClientProvider url="mock">
              <SyncProvider>
                <ThemeProvider mode="dark">
                  <KeybindProvider>
                    <DialogProvider>
                      <OpenDialogOnMount render={render} />
                    </DialogProvider>
                  </KeybindProvider>
                </ThemeProvider>
              </SyncProvider>
            </RuntimeClientProvider>
          </ToastProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  )
}

async function renderSettled(setup: Awaited<ReturnType<typeof testRender>>, passes = 4) {
  for (let index = 0; index < passes; index += 1) {
    await tick()
    await setup.renderOnce()
  }
}

function captureText(setup: Awaited<ReturnType<typeof testRender>>) {
  const frame = setup.captureSpans()
  return frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
}

describe("standard TUI dialogs", () => {
  it("renders alert with a single bracketed confirmation action", async () => {
    const setup = await testRender(
      () => renderDialogHarness(() => <DialogAlert title="Notice" message="All set" />),
      { width: 100, height: 32, kittyKeyboard: true },
    )

    try {
      await renderSettled(setup)

      const text = captureText(setup)
      expect(text).toContain("[确认]")
      expect(text).not.toContain("[关闭(esc)]")
      expect(text).not.toContain("ok")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders bracketed confirm actions", async () => {
    const setup = await testRender(
      () => renderDialogHarness(() => <DialogConfirm title="Delete" message="Delete this item?" />),
      { width: 100, height: 32, kittyKeyboard: true },
    )

    try {
      await renderSettled(setup)

      const text = captureText(setup)
      expect(text).toContain("[取消]")
      expect(text).toContain("[确认]")
      expect(text).not.toContain("[关闭(esc)]")
      expect(text.indexOf("[确认]")).toBeLessThan(text.indexOf("[取消]"))
      expect(text).not.toContain("Cancel")
      expect(text).not.toContain("Confirm")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders prompt submit and cancel as bracketed actions", async () => {
    const setup = await testRender(
      () => renderDialogHarness(() => <DialogPrompt title="Rename" placeholder="Name" />),
      { width: 100, height: 32, kittyKeyboard: true },
    )

    try {
      await renderSettled(setup)

      const text = captureText(setup)
      expect(text).toContain("[取消]")
      expect(text).toContain("[确认]")
      expect(text).not.toContain("[关闭(esc)]")
      expect(text.indexOf("[确认]")).toBeLessThan(text.indexOf("[取消]"))
      expect(text).not.toContain("enter submit")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders session rename as a form without a duplicate close action", async () => {
    const setup = await testRender(
      () => renderDialogHarness(() => <DialogSessionRename session="ses_1" />),
      { width: 100, height: 32, kittyKeyboard: true },
    )

    try {
      await renderSettled(setup)

      const text = captureText(setup)
      expect(text).toContain("Rename Session")
      expect(text).toContain("[确认]")
      expect(text).toContain("[取消]")
      expect(text).not.toContain("[关闭(esc)]")
      expect(text.indexOf("[确认]")).toBeLessThan(text.indexOf("[取消]"))
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders DialogSelect search clear and keeps filtered rows recoverable", async () => {
    const setup = await testRender(
      () =>
        renderDialogHarness(() => (
          <DialogSelect
            title="Choose"
            options={[
              { title: "Alpha option", value: "alpha" },
              { title: "Beta option", value: "beta" },
            ]}
          />
        )),
      { width: 100, height: 32, kittyKeyboard: true },
    )

    try {
      await renderSettled(setup)
      expect(captureText(setup)).toContain("[清空]")

      await setup.mockInput.typeText("beta")
      await renderSettled(setup)
      expect(captureText(setup)).toContain("Beta option")
      expect(captureText(setup)).not.toContain("Alpha option")

      setup.mockInput.pressKey("l", { ctrl: true })
      await renderSettled(setup)
      const text = captureText(setup)
      expect(text).toContain("Alpha option")
      expect(text).toContain("Beta option")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders Help with a bracketed confirmation action", async () => {
    const setup = await testRender(() => renderDialogHarness(() => <DialogHelp />), {
      width: 110,
      height: 36,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup)

      const text = captureText(setup)
      expect(text).toContain("[确认]")
      expect(text).not.toContain("[关闭(esc)]")
      expect(text).not.toContain("ok")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("renders Export Options with bracketed form actions", async () => {
    const setup = await testRender(
      () =>
        renderDialogHarness(() => (
          <DialogExportOptions
            defaultFilename="session.md"
            defaultThinking={true}
            defaultToolDetails={false}
            defaultAssistantMetadata={false}
            defaultOpenWithoutSaving={false}
          />
        )),
      { width: 110, height: 36, kittyKeyboard: true },
    )

    try {
      await renderSettled(setup)

      const text = captureText(setup)
      expect(text).toContain("[取消]")
      expect(text).toContain("[确认]")
      expect(text).not.toContain("[关闭(esc)]")
      expect(text.indexOf("[确认]")).toBeLessThan(text.indexOf("[取消]"))
      expect(text).toContain("return confirms")
    } finally {
      setup.renderer.destroy()
    }
  })
})
