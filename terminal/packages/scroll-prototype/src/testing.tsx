import { CodeRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ScrollPrototype, type PrototypeHandle, type PrototypeProps } from "./view"

export async function createPrototypeHarness(props: Omit<PrototypeProps, "onReady">, width = 120, height = 40) {
  let handle!: PrototypeHandle
  const ui = await testRender(() => <ScrollPrototype {...props} onReady={value => { handle = value }} />,
    { width, height, kittyKeyboard: true })
  const waitForContent = async () => {
    const pending: Promise<void>[] = []
    const collect = (node: Renderable) => {
      if (node instanceof CodeRenderable) pending.push(node.highlightingDone)
      for (const child of node.getChildren()) collect(child)
    }
    collect(ui.renderer.root)
    await Promise.all(pending)
  }
  return { ...ui, handle, waitForContent, close: () => ui.renderer.destroy() }
}
