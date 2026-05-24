import { ExampleDemoResponse } from "@shared/composer";
import { exampleTimestamp } from "../runtime";

export const buildDemoResponse = (): ExampleDemoResponse => ({
  message: "demo ready",
  timestamp: exampleTimestamp(),
});
