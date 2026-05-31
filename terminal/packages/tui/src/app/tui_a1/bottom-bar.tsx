/** @jsxImportSource @opentui/solid */
import { BusyBeacon } from "../../ui/primitives/prompt/busy-beacon"
import { Show } from "solid-js"
import { tuiA1Theme as theme } from "./theme"

function ActionButton(props: {
  label: string
  color?: typeof theme.textMuted
  onClick?: () => void
}) {
  return (
    <box
      flexShrink={0}
      paddingLeft={1}
      onMouseUp={() => {
        props.onClick?.()
      }}
    >
      <text fg={props.color ?? theme.textMuted}>{`[${props.label}]`}</text>
    </box>
  )
}

function BottomBeacon(props: {
  busy: boolean
  side: "left" | "right"
}) {
  const beaconState = () => (props.busy ? "busy" : "idle")
  return (
    <box
      flexShrink={0}
      paddingLeft={props.side === "right" ? 1 : 0}
      paddingRight={props.side === "left" ? 1 : 0}
    >
      <BusyBeacon color={theme.accent} enabled state={beaconState()} side={props.side} />
    </box>
  )
}

export function BottomBar(props: {
  busy: boolean
  metricsLabel: string
  questionnaireLabel?: string
  questionnaireHighlighted?: boolean
  actorListLabel?: string
  messageListLabel?: string
  sessionListLabel?: string
  functionMenuLabel?: string
  onOpenQuestionnaires?: () => void
  onOpenActorList?: () => void
  onOpenMessageList?: () => void
  onOpenSessionList?: () => void
  onOpenFunctionMenu?: () => void
}) {
  const questionnaireColor = () =>
    props.questionnaireHighlighted ? theme.warning : theme.textMuted

  return (
    <box
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      paddingTop={0}
      paddingBottom={0}
    >
      <BottomBeacon busy={props.busy} side="left" />
      <box flexShrink={0}>
        <text fg={theme.textMuted}>{props.metricsLabel}</text>
      </box>
      <box flexGrow={1} />
      <Show when={props.questionnaireLabel}>
        <ActionButton label={props.questionnaireLabel!} color={questionnaireColor()} onClick={props.onOpenQuestionnaires} />
      </Show>
      <ActionButton label={props.messageListLabel ?? "消息"} onClick={props.onOpenMessageList} />
      <ActionButton label={props.sessionListLabel ?? "会话"} onClick={props.onOpenSessionList} />
      <ActionButton label={props.actorListLabel ?? "Actor"} onClick={props.onOpenActorList} />
      <ActionButton label={props.functionMenuLabel ?? "菜单"} onClick={props.onOpenFunctionMenu} />
      <BottomBeacon busy={props.busy} side="right" />
    </box>
  )
}
