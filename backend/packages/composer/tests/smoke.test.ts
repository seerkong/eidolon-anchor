import { test, expect } from "bun:test"

test("@backend/composer exports load", async () => {
  const mod = await import("../src/index")
  expect(typeof mod).toBe("object")
})
