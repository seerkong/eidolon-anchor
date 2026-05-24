export class CancelledError extends Error {
  static isInstance(input: unknown): input is CancelledError {
    return input instanceof CancelledError
  }
}

export const UI = {
  Style: {
    TEXT_NORMAL: "",
    TEXT_DIM: "",
    TEXT_DIM_BOLD: "",
    TEXT_INFO_BOLD: "",
    TEXT_WARNING_BOLD: "",
    TEXT_SUCCESS_BOLD: "",
    TEXT_DANGER_BOLD: "",
    TEXT_HIGHLIGHT_BOLD: "",
  },
  CancelledError,
  show: async () => {},
  empty: () => {},
  println: (...args: unknown[]) => {
    if (args.length > 0) console.log(...args)
  },
  error: (...args: unknown[]) => {
    if (args.length > 0) console.error(...args)
  },
  markdown: (text: string) => text,
  logo: (text: string) => text,
}
