export class Locale {
  static t(key: string, fallback?: string): string {
    return fallback ?? key
  }

  static pluralize(count: number, singular: string, plural: string): string {
    const template = count === 1 ? singular : plural
    return template.replace("{}", String(count))
  }

  static truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    if (maxLength <= 1) return "…"
    return text.slice(0, Math.max(0, maxLength - 1)) + "…"
  }

  static truncateMiddle(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    if (maxLength <= 1) return "…"
    const keep = Math.max(1, maxLength - 1)
    const head = Math.ceil(keep / 2)
    const tail = Math.floor(keep / 2)
    return text.slice(0, head) + "…" + text.slice(text.length - tail)
  }

  static titlecase(text: string): string {
    if (!text) return text
    return text
      .split(/\s+/)
      .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : ""))
      .join(" ")
  }

  static time(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  static datetime(timestamp: number): string {
    return new Date(timestamp).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  static todayTimeOrDateTime(timestamp: number): string {
    const date = new Date(timestamp)
    const now = new Date()
    const isToday =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    return isToday ? Locale.time(timestamp) : Locale.datetime(timestamp)
  }

  static duration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "0s"
    const seconds = Math.round(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remaining = seconds % 60
    if (minutes < 60) return `${minutes}m ${remaining}s`
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return `${hours}h ${mins}m`
  }
}
