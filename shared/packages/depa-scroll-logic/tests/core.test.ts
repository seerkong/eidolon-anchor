import { test } from "bun:test";
import { coreCases } from "./core-cases.ts";

for (const scenario of coreCases) test(scenario.id, () => scenario.run());
