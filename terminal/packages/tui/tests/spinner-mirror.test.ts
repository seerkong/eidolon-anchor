import { describe, expect, it } from "bun:test"
import { createFrames } from "../src/ui/spinner"

describe("spinner mirror frames", () => {
  it("mirrors knight-rider frames for right-side beacons", () => {
    const left = createFrames({ style: "blocks", width: 8, holdStart: 0, holdEnd: 0, mirror: false })
    const right = createFrames({ style: "blocks", width: 8, holdStart: 0, holdEnd: 0, mirror: true })

    expect(left.length).toBe(right.length)
    expect(right[0]).toBe(left[0].split("").reverse().join(""))
    expect(right[3]).toBe(left[3].split("").reverse().join(""))
    expect(right[right.length - 1]).toBe(left[left.length - 1].split("").reverse().join(""))
  })
})
