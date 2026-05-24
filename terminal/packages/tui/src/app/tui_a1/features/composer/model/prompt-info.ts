type PromptTextSource = {
  start: number
  end: number
  value: string
}

type PromptAgentPart = {
  type: "agent"
  name: string
  source?: {
    start: number
    end: number
    value?: string
  }
}

type PromptFilePart = {
  type: "file"
  filename?: string
  mime: string
  url?: string
  source?: {
    type?: string
    path?: string
    text?: PromptTextSource
    [key: string]: unknown
  }
}

type PromptTextPart = {
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  source?: {
    text: PromptTextSource
    [key: string]: unknown
  }
}

export type PromptInfo = {
  input: string
  mode?: "normal" | "shell"
  parts: (PromptFilePart | PromptAgentPart | PromptTextPart)[]
}
