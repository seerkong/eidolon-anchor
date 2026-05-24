export type RuntimeLogLevel = "info" | "warn" | "error" | "debug";

export type RuntimeLogFn = (
  level: RuntimeLogLevel,
  message: string,
  context?: Record<string, unknown>,
) => void;
