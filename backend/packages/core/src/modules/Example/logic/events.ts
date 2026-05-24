import { ExampleSSEEvent } from "@shared/composer";
import { exampleTimestamp } from "../runtime";

export function* defaultExampleEvents(): Generator<ExampleSSEEvent> {
  const now = () => exampleTimestamp();
  yield { event: "start", data: "SSE演示已开始" };
  yield { event: "message", data: "正在处理..." };
  yield { event: "message", data: "仍在进行..." };
  yield { event: "done", data: `完成！@${now()}` };
}
