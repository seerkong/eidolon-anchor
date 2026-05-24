export type TuiMessageCategory =
  | "think"
  | "assist"
  | "toolcall"
  | "result"
  | "turn"
  | "done"
  | "questionnaire"
  | "quote"
  | "notice"
  | "error"


export type TuiControl = {
  cmd: "NewMessage"
  category?: TuiMessageCategory
}

export type TuiControlEvent = {
  kind: "control"
  payload: TuiControl
}

export type TuiMessageEvent = {
  kind: "message"
  payload: string
}

export type TuiEvent = TuiControlEvent | TuiMessageEvent
