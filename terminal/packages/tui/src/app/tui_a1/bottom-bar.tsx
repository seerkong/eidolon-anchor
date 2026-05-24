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

export function BottomBar(props: {
  busy: boolean
  metricsLabel: string
  questionnaireLabel?: string
  questionnaireHighlighted?: boolean
  usageLabel?: string
  messageListLabel?: string
  sessionListLabel?: string
  functionMenuLabel?: string
  onOpenQuestionnaires?: () => void
  onOpenUsage?: () => void
  onOpenMessageList?: () => void
  onOpenSessionList?: () => void
  onOpenFunctionMenu?: () => void
}) {
  const beaconState = () => (props.busy ? "busy" : "idle")
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
      <BusyBeacon color={theme.accent} enabled state={beaconState()} side="left" />
      <box flexShrink={0} paddingLeft={1}>
        <text fg={theme.textMuted}>{props.metricsLabel}</text>
      </box>
      <box flexGrow={1} />
      <Show when={props.questionnaireLabel}>
        <ActionButton label={props.questionnaireLabel!} color={questionnaireColor()} onClick={props.onOpenQuestionnaires} />
      </Show>
      <ActionButton label={props.messageListLabel ?? "消息列表"} onClick={props.onOpenMessageList} />
      <ActionButton label={props.sessionListLabel ?? "会话列表"} onClick={props.onOpenSessionList} />
      <ActionButton label={props.usageLabel ?? "使用说明"} onClick={props.onOpenUsage} />
      <ActionButton label={props.functionMenuLabel ?? "功能菜单"} onClick={props.onOpenFunctionMenu} />
      <BusyBeacon color={theme.accent} enabled state={beaconState()} side="right" />
    </box>
  )
}
