# Scroll prototype

Private standalone OpenTUI consumer of `depa-scroll-opentui-capsule`. Both log and chat modes use `ScrollPrototype`; the host supplies row content, while the capsule owns windowing, paging, measurements and navigation state.

From the repository root, with Bun on PATH:

```sh
bun run --cwd terminal/packages/scroll-prototype dev --shape=log --count=100000 --tail-lines=800
bun run --cwd terminal/packages/scroll-prototype dev --shape=chat --count=1000
bun run --cwd terminal/packages/scroll-prototype test
bun run --cwd terminal/packages/scroll-prototype benchmark
```

Home, PageUp/PageDown, wheel and scrollbar drag use the focused native scrollbox. End requests the authoritative latest page. Enter appends a synthetic row and jumps to latest; `l` appends while retaining the current reading intent; `u` grows the tail and `v` completes it. `x` toggles a visible tool card, `c` changes composer height, `t` switches log/chat and `a` switches actor. `[`/`]` request an adjacent page. `f` arms the next fault (timeout, rejection, stale cursor, budget, nonprogress, empty page, controlled delay), `d` releases a controlled delay, `r` retries and Escape cancels. `q` exits.

The header shows page status, intent, unread and cache/mount counts. The composer displays the current error and the four latest controller diagnostic codes. Full bounded controller diagnostics are available at `handle.runtime.state().diagnostics`; source request outcomes at `handle.source().trace()`. A trace contains IDs/codes/counts, not row bodies.

`src/testing.tsx` exports `createPrototypeHarness({ source, config?, composerHeight?, renderRow? }, width?, height?)`. It returns native test renderer controls plus a handle exposing the public runtime, scrollbox, mounted nodes, source mutation, fault injection and source switching. `waitForContent()` awaits the public `CodeRenderable.highlightingDone` promises, including Markdown's native code children; render another frame afterward to observe completed highlighting. Parser assets are loaded from the installed OpenTUI package.

`createSyntheticSource` indexes rows arithmetically and materializes only requested pages. Source pages are capped at 160 bodies, the tail at 800 lines, revision metadata at 160 entries and traces at 64 entries by default. Exhausting revision metadata produces an explicit budget failure. `stats().retainedBodies` counts in-flight source page bodies; controller page/live/measurement bounds are separate. Latest snapshots all source changes visible at invocation, before an injected delay, so concurrent live updates can exercise the controller's reconciliation contract.

The measured outer row includes padding and the card border once. The shared `depa-scroll-opentui-capsule/solid` component owns row registration and the dedicated mounted-row container between static top/bottom spacers. The composer is a separate sibling; the scroll viewport uses `minHeight=0` and `stickyScroll=false`.

The benchmark uses actual native layouts for both short log and chat consumers at all three source sizes, with ten warmups and one hundred measured inputs per combination. It asserts the locked 500 ms first-interactive, 100 ms P95/maximum event-loop pause and two-layout-cycle visible coverage bounds, reports stabilization separately, and emits raw RSS plus explicit GC checkpoints for ten repeated disposal cycles. Long-card and paging/live acceptance belongs to the separate native matrix, not this interior-scroll performance scenario.
