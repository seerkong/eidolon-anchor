/**
 * Crockford-base32 ULID generator.
 * Used as xnl TextElement marker to prevent content collision with closing tags.
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number, length: number): string {
  let out = "";
  for (let i = length - 1; i >= 0; i--) {
    out = ENCODING.charAt(time % 32) + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(values: number[]): string {
  return values.map((v) => ENCODING.charAt(v)).join("");
}

function nextRandom(): number[] {
  return Array.from({ length: 16 }, () => (Math.random() * 32) | 0);
}

function incrementRandom(random: number[]): number[] {
  const next = [...random];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] < 31) {
      next[i] += 1;
      return next;
    }
    next[i] = 0;
  }
  return next;
}

export function makeUlid(now = Date.now()): string {
  if (now > lastTime) {
    lastTime = now;
    lastRandom = nextRandom();
  } else {
    lastRandom = incrementRandom(lastRandom);
  }
  return encodeTime(lastTime, 10) + encodeRandom(lastRandom);
}

/** Exposed for test isolation only. */
export function __resetUlidForTest(): void {
  lastTime = -1;
  lastRandom = [];
}
