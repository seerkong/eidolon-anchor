const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

let lastTime = -1
let lastRandom: number[] = []

function encodeTime(time: number, length: number): string {
  let out = ""
  for (let i = length - 1; i >= 0; i--) {
    out = ENCODING[time % 32] + out
    time = Math.floor(time / 32)
  }
  return out
}

function nextRandomArray(length: number): number[] {
  return Array.from({ length }, () => Math.floor(Math.random() * 32))
}

function incrementRandom(random: number[]): number[] {
  const next = [...random]
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i] < 31) {
      next[i] += 1
      return next
    }
    next[i] = 0
  }
  return next
}

function encodeRandom(values: number[]): string {
  return values.map((value) => ENCODING[value] ?? ENCODING[0]).join("")
}

export function makeSessionUlid(now = Date.now()): string {
  if (now > lastTime) {
    lastTime = now
    lastRandom = nextRandomArray(16)
  } else {
    lastRandom = incrementRandom(lastRandom.length ? lastRandom : nextRandomArray(16))
  }
  return `${encodeTime(lastTime, 10)}${encodeRandom(lastRandom)}`
}

function pad2(value: number): string {
  return `${value}`.padStart(2, "0")
}

export function formatSessionTimestamp(now = Date.now()): string {
  const date = new Date(now)
  const year = date.getFullYear()
  const month = pad2(date.getMonth() + 1)
  const day = pad2(date.getDate())
  const hour = pad2(date.getHours())
  const minute = pad2(date.getMinutes())
  const second = pad2(date.getSeconds())
  return `${year}${month}${day}${hour}${minute}${second}`
}

export function makeSessionKey(now = Date.now()): string {
  return `${formatSessionTimestamp(now)}__${makeSessionUlid(now)}`
}

export function __resetSessionUlidForTest(): void {
  lastTime = -1
  lastRandom = []
}
