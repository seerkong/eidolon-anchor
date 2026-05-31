/** @jsxImportSource @opentui/solid */
import path from "path"
import { readdir } from "fs/promises"
import { RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { selectedForeground, useTheme } from "../../../../providers/theme"
import { createEffect, createMemo, createResource, createSignal, For, onMount, Show } from "solid-js"
import { DialogHeader, useDialog } from "../../../../ui/dialog/context"
import { useFrecency } from "../../perf/frecency"

const DEFAULT_MAX_FILES = 2000
const IGNORED_DIRS = new Set([".git", ".idea", ".next", ".turbo", "coverage", "dist", "node_modules"])

export type WorkspaceFileCandidate = {
  absolutePath: string
  relativePath: string
  frecency: number
}

export type WorkspaceFileTreeNode = {
  kind: "directory" | "file"
  name: string
  absolutePath: string
  relativePath: string
  children?: WorkspaceFileTreeNode[]
}

export type WorkspaceFileTreeRow = {
  id: string
  depth: number
  expanded: boolean
  frecency: number
  node: WorkspaceFileTreeNode
  parentRelativePath: string | null
}

export function formatWorkspaceBreadcrumb(rootName: string, row?: WorkspaceFileTreeRow): string {
  if (!row) return `path ${rootName}`
  const parts = row.node.relativePath.split("/").filter(Boolean)
  return `path ${[rootName, ...parts].join(" / ")}`
}

export function filterWorkspaceFileTree(root: WorkspaceFileTreeNode, query: string): WorkspaceFileTreeNode {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return root

  const visit = (node: WorkspaceFileTreeNode): WorkspaceFileTreeNode | null => {
    const matches = node.relativePath.toLowerCase().includes(normalized) || node.name.toLowerCase().includes(normalized)
    if (node.kind === "file") {
      return matches ? { ...node } : null
    }

    const children = (node.children ?? [])
      .map((child) => visit(child))
      .filter((child): child is WorkspaceFileTreeNode => child !== null)

    if (matches || children.length > 0 || node.relativePath === "") {
      return {
        ...node,
        children,
      }
    }

    return null
  }

  return visit(root) ?? { ...root, children: [] }
}

export function collectWorkspaceDirectoryPaths(root: WorkspaceFileTreeNode): Set<string> {
  const result = new Set<string>()

  const visit = (node: WorkspaceFileTreeNode) => {
    if (node.kind === "directory" && node.relativePath) {
      result.add(node.relativePath)
    }
    for (const child of node.children ?? []) {
      visit(child)
    }
  }

  visit(root)
  return result
}

export function readWorkspaceFilterCharacter(event: {
  ctrl?: boolean
  meta?: boolean
  alt?: boolean
  sequence?: string
  name?: string
}): string | undefined {
  if (event.ctrl || event.meta || event.alt) return undefined
  const value = event.sequence && event.sequence.length === 1 ? event.sequence : event.name
  if (!value || value.length !== 1) return undefined
  if (value < " ") return undefined
  return value
}

export function compareWorkspaceFileCandidates(
  left: WorkspaceFileCandidate,
  right: WorkspaceFileCandidate,
): number {
  if (right.frecency !== left.frecency) return right.frecency - left.frecency
  return left.relativePath.localeCompare(right.relativePath)
}

export async function listWorkspaceFiles(directory: string, limit = DEFAULT_MAX_FILES): Promise<string[]> {
  const results: string[] = []
  const queue: string[] = [directory]

  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift()
    if (!current) break
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) queue.push(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      results.push(absolutePath)
      if (results.length >= limit) break
    }
  }

  return results
}

export function buildWorkspaceFileTree(directory: string, files: string[]): WorkspaceFileTreeNode {
  const root: WorkspaceFileTreeNode = {
    kind: "directory",
    name: path.basename(directory) || directory,
    absolutePath: directory,
    relativePath: "",
    children: [],
  }

  for (const absolutePath of files) {
    const relativePath = path.relative(directory, absolutePath) || path.basename(absolutePath)
    const parts = relativePath.split(path.sep).filter(Boolean)
    let current = root

    for (const [index, part] of parts.entries()) {
      const isLeaf = index === parts.length - 1
      const nextRelativePath = parts.slice(0, index + 1).join("/")
      current.children ??= []

      if (isLeaf) {
        current.children.push({
          kind: "file",
          name: part,
          absolutePath,
          relativePath: nextRelativePath,
        })
        continue
      }

      let child = current.children.find(
        (entry) => entry.kind === "directory" && entry.relativePath === nextRelativePath,
      )
      if (!child) {
        child = {
          kind: "directory",
          name: part,
          absolutePath: path.join(directory, ...parts.slice(0, index + 1)),
          relativePath: nextRelativePath,
          children: [],
        }
        current.children.push(child)
      }
      current = child
    }
  }

  return root
}

export function flattenWorkspaceFileTree(
  root: WorkspaceFileTreeNode,
  expanded: ReadonlySet<string>,
  getFrecency: (filePath: string) => number,
): WorkspaceFileTreeRow[] {
  const rows: WorkspaceFileTreeRow[] = []

  const walk = (node: WorkspaceFileTreeNode, depth: number, parentRelativePath: string | null) => {
    const children = [...(node.children ?? [])].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1
      if (left.kind === "directory" && right.kind === "directory") {
        return left.name.localeCompare(right.name)
      }
      return compareWorkspaceFileCandidates(
        {
          absolutePath: left.absolutePath,
          relativePath: left.relativePath,
          frecency: getFrecency(left.absolutePath),
        },
        {
          absolutePath: right.absolutePath,
          relativePath: right.relativePath,
          frecency: getFrecency(right.absolutePath),
        },
      )
    })

    for (const child of children) {
      const childExpanded = child.kind === "directory" && expanded.has(child.relativePath)
      rows.push({
        id: child.relativePath || child.absolutePath,
        depth,
        expanded: childExpanded,
        frecency: child.kind === "file" ? getFrecency(child.absolutePath) : 0,
        node: child,
        parentRelativePath,
      })

      if (child.kind === "directory" && childExpanded) {
        walk(child, depth + 1, child.relativePath)
      }
    }
  }

  walk(root, 0, null)
  return rows
}

export function acceptWorkspaceFileCandidate(
  file: WorkspaceFileCandidate,
  updateFrecency: (filePath: string) => void,
  onSelect: (file: WorkspaceFileCandidate) => void,
) {
  updateFrecency(file.absolutePath)
  onSelect(file)
}

function formatWorkspaceFileCandidate(node: WorkspaceFileTreeNode, getFrecency: (filePath: string) => number): WorkspaceFileCandidate {
  return {
    absolutePath: node.absolutePath,
    relativePath: node.relativePath,
    frecency: getFrecency(node.absolutePath),
  }
}

export function DialogWorkspaceFilePicker(props: {
  directory: string
  onSelect: (file: WorkspaceFileCandidate) => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const frecency = useFrecency()
  const dimensions = useTerminalDimensions()
  const [files] = createResource(() => listWorkspaceFiles(props.directory))
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  let scroll: ScrollBoxRenderable | undefined

  const tree = createMemo(() => buildWorkspaceFileTree(props.directory, files() ?? []))
  const filteredTree = createMemo(() => filterWorkspaceFileTree(tree(), query()))
  const visibleExpanded = createMemo(() => (query().trim() ? collectWorkspaceDirectoryPaths(filteredTree()) : expanded()))
  const rows = createMemo(() => flattenWorkspaceFileTree(filteredTree(), visibleExpanded(), frecency.getFrecency))
  const selectedRow = createMemo(() => rows()[selected()])
  const pageSize = createMemo(() => Math.max(6, Math.floor(dimensions().height * 0.2)))
  const breadcrumb = createMemo(() => formatWorkspaceBreadcrumb(tree().name, selectedRow()))

  onMount(() => {
    dialog.setSize("xlarge")
  })

  createEffect(() => {
    if (rows().length === 0) {
      setSelected(0)
      return
    }
    const next = Math.min(selected(), rows().length - 1)
    if (next !== selected()) setSelected(next)
  })

  function move(direction: number) {
    if (rows().length === 0) return
    let next = selected() + direction
    if (next < 0) next = rows().length - 1
    if (next >= rows().length) next = 0
    setSelected(next)
    scroll?.scrollChildIntoView(rows()[next]!.id)
  }

  function handleWheel(event: {
    scroll?: { direction?: string }
    preventDefault: () => void
    stopPropagation: () => void
  }) {
    if (!scroll || !event.scroll?.direction) return
    const amount = Math.max(3, Math.floor(pageSize() / 2))
    if (event.scroll.direction === "up") scroll.scrollBy(-amount)
    if (event.scroll.direction === "down") scroll.scrollBy(amount)
    event.preventDefault()
    event.stopPropagation()
  }

  function setExpandedState(relativePath: string, value: boolean) {
    setExpanded((current) => {
      const next = new Set(current)
      if (value) {
        next.add(relativePath)
      } else {
        next.delete(relativePath)
      }
      return next
    })
  }

  function toggleDirectory(relativePath: string) {
    setExpandedState(relativePath, !expanded().has(relativePath))
  }

  function moveToParent(row: WorkspaceFileTreeRow | undefined) {
    if (!row?.parentRelativePath) return
    const index = rows().findIndex((entry) => entry.node.relativePath === row.parentRelativePath)
    if (index >= 0) {
      setSelected(index)
      scroll?.scrollChildIntoView(rows()[index]!.id)
    }
  }

  function chooseCurrent(row: WorkspaceFileTreeRow | undefined) {
    if (!row) return
    if (row.node.kind === "directory") {
      toggleDirectory(row.node.relativePath)
      return
    }
    const candidate = formatWorkspaceFileCandidate(row.node, frecency.getFrecency)
    frecency.updateFrecency(candidate.absolutePath)
    dialog.clear()
    setTimeout(() => props.onSelect(candidate), 1)
  }

  useKeyboard((evt) => {
    if (files.state !== "ready") return
    if (evt.name === "backspace" && query().length > 0) {
      evt.preventDefault()
      setQuery((current) => current.slice(0, -1))
      return
    }
    if (evt.ctrl && evt.name === "l") {
      evt.preventDefault()
      setQuery("")
      return
    }
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      evt.preventDefault()
      move(-1)
      return
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      evt.preventDefault()
      move(1)
      return
    }
    if (evt.name === "pageup") {
      evt.preventDefault()
      move(-pageSize())
      return
    }
    if (evt.name === "pagedown") {
      evt.preventDefault()
      move(pageSize())
      return
    }
    if (evt.name === "home") {
      evt.preventDefault()
      setSelected(0)
      scroll?.scrollTo(0)
      return
    }
    if (evt.name === "end") {
      evt.preventDefault()
      const nextIndex = Math.max(0, rows().length - 1)
      setSelected(nextIndex)
      scroll?.scrollTo(scroll.scrollHeight)
      return
    }
    if (evt.name === "left") {
      const row = selectedRow()
      if (!row) return
      evt.preventDefault()
      if (row.node.kind === "directory" && row.expanded) {
        setExpandedState(row.node.relativePath, false)
        return
      }
      moveToParent(row)
      return
    }
    if (evt.name === "right") {
      const row = selectedRow()
      if (!row || row.node.kind !== "directory") return
      evt.preventDefault()
      if (!row.expanded) {
        setExpandedState(row.node.relativePath, true)
        return
      }
      const nextIndex = selected() + 1
      if (nextIndex < rows().length) {
        setSelected(nextIndex)
        scroll?.scrollChildIntoView(rows()[nextIndex]!.id)
      }
      return
    }
    if (evt.name === "return" || evt.name === "linefeed" || evt.name === "kpenter") {
      evt.preventDefault()
      evt.stopPropagation()
      chooseCurrent(selectedRow())
      return
    }
    const char = readWorkspaceFilterCharacter(evt)
    if (char) {
      evt.preventDefault()
      setQuery((current) => current + char)
    }
  })

  return (
    <Show
      when={files.state === "ready"}
      fallback={
        <box gap={1} paddingBottom={1} height="100%" flexDirection="column">
          <box paddingLeft={4} paddingRight={4}>
            <DialogHeader title="Insert file" />
            <box paddingTop={1}>
              <text fg={theme.textMuted}>Indexing workspace tree…</text>
            </box>
          </box>
        </box>
      }
    >
      <box gap={1} paddingBottom={1} height="100%" flexDirection="column" onMouseScroll={handleWheel}>
        <box paddingLeft={4} paddingRight={4}>
          <DialogHeader title="Insert file" />
          <box paddingTop={1} flexDirection="column" gap={0}>
            <box height={1}>
              <text fg={theme.textMuted}>Right expand directory · Left collapse or go parent</text>
            </box>
            <box height={1}>
              <text fg={theme.accent} wrapMode="char">
                {breadcrumb()}
              </text>
            </box>
            <box flexDirection="row" height={1}>
              <text flexGrow={1} fg={query().trim() ? theme.warning : theme.textMuted} wrapMode="char">
                {query().trim() ? `filter ${query()}` : "filter all files"}
              </text>
              <text
                flexShrink={0}
                fg={theme.secondary}
                attributes={TextAttributes.BOLD}
                onMouseUp={(evt) => {
                  evt.stopPropagation()
                  setQuery("")
                  setSelected(0)
                  scroll?.scrollTo(0)
                }}
              >
                [清空]
              </text>
            </box>
            <box height={1}>
              <text fg={theme.textMuted} wrapMode="char">
                Enter insert file into prompt · Type to filter · Backspace delete
              </text>
            </box>
          </box>
        </box>

        <box flexGrow={1} minHeight={0}>
          <Show
            when={rows().length > 0}
            fallback={
              <box height="100%" paddingLeft={4} paddingRight={4} paddingTop={1}>
                <text fg={theme.textMuted}>No files found</text>
              </box>
            }
          >
          <scrollbox
            scrollY={true}
            scrollX={false}
            paddingLeft={1}
            paddingRight={1}
            scrollbarOptions={{ visible: true }}
            ref={(value: ScrollBoxRenderable) => (scroll = value)}
            height="100%"
            onMouseScroll={handleWheel}
          >
            <For each={rows()}>
              {(row, index) => {
                const active = createMemo(() => index() === selected())
                const label = createMemo(() => {
                  const indent = "  ".repeat(row.depth)
                  if (row.node.kind === "directory") {
                    return `${indent}${row.expanded ? "v" : ">"} ${row.node.name}/`
                  }
                  return `${indent}  ${row.node.name}`
                })
                return (
                  <box
                    id={row.id}
                    flexDirection="row"
                    backgroundColor={active() ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
                    paddingLeft={3}
                    paddingRight={3}
                    onMouseScroll={handleWheel}
                    onMouseOver={() => setSelected(index())}
                    onMouseUp={() => {
                      setSelected(index())
                      chooseCurrent(row)
                    }}
                  >
                    <text
                      flexGrow={1}
                      fg={active() ? selectedForeground(theme) : row.node.kind === "directory" ? theme.accent : theme.text}
                      attributes={active() ? TextAttributes.BOLD : undefined}
                    >
                      {label()}
                    </text>
                  </box>
                )
              }}
            </For>
          </scrollbox>
          </Show>
        </box>
      </box>
    </Show>
  )
}
