import type { BoxRenderable } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createMemo, For, onCleanup, onMount } from "solid-js";
import type { ScrollRow } from "depa-scroll-contract";
import type { createOpenTuiScrollRuntime } from "./index";

type Controller<T> = ReturnType<typeof createOpenTuiScrollRuntime<T>>;

/** Static spacer siblings must not share an insertion parent with dynamic rows. */
export function ScrollWindowContent<T>(props: {
  readonly runtime: Controller<T>;
  readonly rowPaddingTop?: number;
  readonly children: (row: () => ScrollRow<T>) => JSX.Element;
  readonly onMountRow?: (node: BoxRenderable) => void;
  readonly onUnmountRow?: (node: BoxRenderable) => void;
}): JSX.Element {
  const keys = createMemo(() => {
    const identity = props.runtime.state().identity;
    const prefix = JSON.stringify([identity.sourceId, identity.actorId, identity.sourceEpoch, identity.generation]);
    return props.runtime.window().rows.map(item => `${prefix}\n${item.row.id}`);
  });
  function Row(input: { readonly id: string }): JSX.Element {
    let outer!: BoxRenderable;
    const row = createMemo<ScrollRow<T> | undefined>(previous =>
      props.runtime.window().rows.find(item => item.row.id === input.id)?.row ?? previous);
    onMount(() => {
      const unregister = props.runtime.registerRow(outer, () => ({ id: row()!.id, contentRevision: row()!.contentRevision }));
      props.onMountRow?.(outer);
      onCleanup(() => { unregister(); props.onUnmountRow?.(outer); });
    });
    return <box ref={outer} width="100%" flexDirection="column" flexShrink={0} paddingTop={props.rowPaddingTop ?? 0}>
      {props.children(() => row()!)}
    </box>;
  }
  return <>
    <box height={props.runtime.window().topSpacer} flexShrink={0} />
    <box width="100%" flexDirection="column" flexShrink={0}>
      {/* JSON escapes newlines in the source prefix; preserve every character after its first separator. */}
      <For each={keys()}>{key => <Row id={key.slice(key.indexOf("\n") + 1)} />}</For>
    </box>
    <box height={props.runtime.window().bottomSpacer} flexShrink={0} />
  </>;
}
