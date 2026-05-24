export type LogFn = (message: string) => void;

export const safeLog = (log: LogFn | undefined, message: string) => {
  if (!log) return;
  log(message);
};

export const summarizeForLog = (body: unknown): string => {
  if (body === undefined) return "undefined";
  if (body === null) return "null";
  if (typeof body === "string") return body.length > 500 ? `${body.slice(0, 500)}...` : body;
  if (typeof body === "object") {
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      return `FormData fields=[${Array.from(body.keys()).join(", ")}]`;
    }
    try {
      const json = JSON.stringify(body);
      return json.length > 500 ? `${json.slice(0, 500)}...` : json;
    } catch {
      return "[unserializable-object]";
    }
  }
  return String(body);
};

export const logEndpointStart = (log: LogFn | undefined, route: string, body?: unknown) => {
  safeLog(log, `endpoint ${route} start body=${summarizeForLog(body)}`);
};
