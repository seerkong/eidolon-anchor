import path from "path"
import type { PermissionRequest, Question, QuestionAnswer, QuestionRequest } from "@terminal/core/AIAgent"

export type PermissionReply = "once" | "always" | "reject"

function readMetaString(request: PermissionRequest, key: string): string | undefined {
  const value = request.metadata?.[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function renderPermissionSummary(request: PermissionRequest): string {
  if (request.permission === "edit") {
    const filepath = readMetaString(request, "filepath")
    if (filepath) return `edit ${filepath}`
  }
  if (request.permission === "bash") {
    const command = readMetaString(request, "command")
    if (command) return command
  }
  const pattern = request.patterns?.find((item) => typeof item === "string" && item.trim().length > 0)
  if (pattern) return pattern
  return request.permission
}

export function formatPermissionReply(reply: PermissionReply): string {
  switch (reply) {
    case "once":
      return "Allowed once"
    case "always":
      return "Allowed always"
    case "reject":
      return "Rejected"
  }
}

export function renderPermissionDetails(request: PermissionRequest): string[] {
  const lines: string[] = []
  const add = (label: string, value: string | undefined) => {
    if (!value) return
    lines.push(`${label}: ${value}`)
  }

  const filepath = readMetaString(request, "filepath")
  const command = readMetaString(request, "command")
  const description = readMetaString(request, "description")
  const query = readMetaString(request, "query")
  const url = readMetaString(request, "url")
  const parentDir = readMetaString(request, "parentDir")
  const pathValue = readMetaString(request, "path")
  const filePath = readMetaString(request, "filePath")

  switch (request.permission) {
    case "edit":
      add("file", filepath)
      break
    case "read":
      add("file", filePath ?? filepath)
      break
    case "list":
      add("path", pathValue ?? filePath ?? filepath)
      break
    case "glob":
    case "grep":
      add("pattern", readMetaString(request, "pattern"))
      break
    case "bash":
      add("description", description)
      add("command", command)
      break
    case "task":
      add("delegate", readMetaString(request, "delegate_type"))
      add("description", description)
      break
    case "webfetch":
      add("url", url)
      break
    case "websearch":
    case "codesearch":
      add("query", query)
      break
    case "external_directory": {
      const rawPattern = request.patterns?.[0]
      const fromPattern =
        typeof rawPattern === "string"
          ? rawPattern.includes("*")
            ? path.dirname(rawPattern)
            : rawPattern
          : undefined
      add("directory", parentDir ?? filepath ?? fromPattern)
      break
    }
  }

  if (request.patterns && request.patterns.length > 0) {
    add("match", request.patterns.join(", "))
  }
  if (request.always && request.always.length > 0) {
    add("allow-once scope", request.always.join(", "))
  }
  if (request.tool) {
    lines.push(`tool: ${request.tool.callID}`)
  }
  return lines
}

export function summarizePermissionHistory(request: PermissionRequest, reply: PermissionReply): string {
  return `${formatPermissionReply(reply)} · ${renderPermissionSummary(request)}`
}

export function formatQuestionAnswer(answer?: QuestionAnswer): string {
  if (!answer?.length) return "(no answer)"
  return answer.join(", ")
}

export function summarizeQuestionHistory(
  request: QuestionRequest,
  answers: QuestionAnswer[] = [],
  rejected = false,
): string {
  if (rejected) {
    return `Rejected · ${request.questions[0]?.question ?? "questionnaire"}`
  }

  const answered = answers.filter((group) => group.length > 0).length
  const details = request.questions
    .map((question, index) => `${question.header}: ${formatQuestionAnswer(answers[index])}`)
    .join(" · ")

  return `Answered ${answered}/${request.questions.length} · ${details}`
}

export function resolveQuestionAnswers(questions: Question[], answers: QuestionAnswer[]): QuestionAnswer[] {
  return questions.map((_, index) => [...(answers[index] ?? [])])
}

export function buildStructuredQuestionAnswers(
  request: QuestionRequest,
  answers: QuestionAnswer[] = [],
): Record<string, string | string[]> {
  return Object.fromEntries(
    request.questions.map((question, index) => {
      const key =
        typeof (question as unknown as { id?: string }).id === "string" && (question as unknown as { id?: string }).id?.trim()
          ? (question as unknown as { id: string }).id.trim()
          : question.header
      const answer = answers[index] ?? []
      return [key, question.multiple ? [...answer] : answer[0] ?? ""]
    }),
  )
}

export function questionnaireAnsweredCount(answers: QuestionAnswer[] = []): number {
  return answers.filter((group) => group.length > 0).length
}

export function questionnaireTitle(request: QuestionRequest): string {
  if (typeof request.title === "string" && request.title.trim()) return request.title.trim()
  if (typeof request.intro === "string" && request.intro.trim()) return request.intro.trim()
  return request.questions[0]?.question ?? "questionnaire"
}
