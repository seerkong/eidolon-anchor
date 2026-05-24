import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";

describe("Questionnaire tool prompt guidance", () => {
  it("includes recommendation intake and travel guidance", () => {
    const promptPath = path.resolve(
      import.meta.dir,
      "../../../../../../cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Questionnaire/Tool.detail.xnl",
    );
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain("prefer one structured questionnaire round");
    expect(prompt).toContain("Prefer 2-4 high-information questions");
    expect(prompt).toContain("For travel recommendation");
    expect(prompt).toContain("questionnaire_travel_intake");
  });
});
