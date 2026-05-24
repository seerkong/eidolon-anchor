import { describe, expect, it } from "bun:test";
import {
  estimateProviderMessageChars,
  resolveAdaptiveFirstEventTimeoutSeconds,
  resolveAdaptiveTimeoutSeconds,
  resolveFirstEventTimeoutSeconds,
  resolveStreamIdleTimeoutSeconds,
  resolveTimeoutSeconds,
  type ProviderStreamTimeoutProfile,
} from "@cell/ai-organ-logic/llm";

const profile: ProviderStreamTimeoutProfile = {
  defaultTimeoutSeconds: 30,
  defaultFirstEventTimeoutSeconds: 10,
  defaultIdleTimeoutSeconds: 8,
  adaptiveTimeoutMaxSeconds: 90,
  adaptiveTimeoutCharThreshold: 100,
  adaptiveTimeoutCharStep: 50,
  adaptiveTimeoutStepSeconds: 5,
  adaptiveTimeoutToolThreshold: 1,
  adaptiveTimeoutToolStep: 2,
  adaptiveTimeoutToolStepSeconds: 7,
  adaptiveFirstEventTimeoutMaxSeconds: 45,
  adaptiveFirstEventTimeoutCharThreshold: 100,
  adaptiveFirstEventTimeoutCharStep: 50,
  adaptiveFirstEventTimeoutStepSeconds: 3,
  adaptiveFirstEventTimeoutToolThreshold: 1,
  adaptiveFirstEventTimeoutToolStep: 2,
  adaptiveFirstEventTimeoutToolStepSeconds: 4,
};

describe("provider stream timeout helpers", () => {
  it("uses explicit request timeout controls when present", () => {
    expect(resolveTimeoutSeconds({ timeout: 12 }, { profile })).toBe(12);
    expect(resolveFirstEventTimeoutSeconds({ first_event_timeout_seconds: 4 }, { profile })).toBe(4);
    expect(resolveFirstEventTimeoutSeconds({ first_event_timeout: 5 }, { profile })).toBe(5);
    expect(resolveStreamIdleTimeoutSeconds({ stream_idle_timeout_seconds: 6 }, { profile })).toBe(6);
    expect(resolveStreamIdleTimeoutSeconds({ stream_idle_timeout: 7 }, { profile })).toBe(7);
  });

  it("estimates message characters and adaptive timeout budget", () => {
    const messages = [{ role: "user", content: "a".repeat(220) }];
    const tools = [{ name: "a" }, { name: "b" }, { name: "c" }];

    expect(estimateProviderMessageChars(messages)).toBe(220);
    expect(resolveAdaptiveTimeoutSeconds({ profile, messages, tools })).toBe(52);
    expect(resolveAdaptiveFirstEventTimeoutSeconds({ profile, messages, tools })).toBe(23);
  });

  it("caps adaptive timeout at profile maximum", () => {
    const messages = [{ role: "user", content: "a".repeat(5000) }];
    const tools = Array.from({ length: 20 }, (_, index) => ({ name: `tool-${index}` }));

    expect(resolveAdaptiveTimeoutSeconds({ profile, messages, tools })).toBe(90);
    expect(resolveAdaptiveFirstEventTimeoutSeconds({ profile, messages, tools })).toBe(45);
  });
});
