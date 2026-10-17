import type { ImmutableJsonValue } from './kernel.js';

const SHA256_INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const encoder = new TextEncoder();

/**
 * Copies the closed JSON own-data subset without invoking user code.
 * Objects are rebuilt with a null prototype and data properties are installed
 * with defineProperty, so keys such as `__proto__` remain ordinary data.
 */
export function canonicalOwnDataClone<Value>(value: Value): Value {
  return clone(value, new Set<object>(), '$') as Value;
}

export function deepFrozenCanonicalOwnDataClone<Value>(value: Value): Value {
  return deepFreeze(canonicalOwnDataClone(value));
}

export function canonicalOwnDataBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(canonicalOwnDataClone(value)));
}

export function canonicalOwnDataDigest(value: unknown): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalOwnDataBytes(value))}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  const bitLength = bytes.byteLength * 8;
  if (!Number.isSafeInteger(bitLength)) throw new RangeError('SHA-256 input is too large');
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = new Uint32Array(SHA256_INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]!;
      const b = words[index - 2]!;
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sigma1 + choose + SHA256_ROUND[index]! + words[index]!) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, '0')).join('');
}

function clone(value: unknown, ancestors: Set<object>, path: string): ImmutableJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(path, 'non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') invalid(path, `unsupported ${typeof value}`);
  const object = value as object;
  if (ancestors.has(object)) invalid(path, 'cycle');
  ancestors.add(object);
  try {
    if (Array.isArray(object)) return cloneArray(object, ancestors, path);
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) invalid(path, 'custom prototype');
    const target = Object.create(null) as Record<string, ImmutableJsonValue>;
    const keys = Reflect.ownKeys(object);
    if (keys.some((key) => typeof key === 'symbol')) invalid(path, 'symbol key');
    const descriptors = Object.getOwnPropertyDescriptors(object);
    for (const key of (keys as string[]).sort(compareUtf16)) {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) invalid(`${path}.${key}`, 'accessor');
      if (!descriptor.enumerable) invalid(`${path}.${key}`, 'non-enumerable property');
      Object.defineProperty(target, key, {
        value: clone(descriptor.value, ancestors, `${path}.${key}`),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return target;
  } finally {
    ancestors.delete(object);
  }
}

function cloneArray(source: unknown[], ancestors: Set<object>, path: string): readonly ImmutableJsonValue[] {
  const keys = Reflect.ownKeys(source);
  if (keys.some((key) => typeof key === 'symbol')) invalid(path, 'symbol key');
  const names = keys as string[];
  if (names.some((key) => key !== 'length' && !isArrayIndex(key, source.length))) invalid(path, 'extra array property');
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const target: ImmutableJsonValue[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const key = String(index);
    const descriptor = descriptors[key];
    if (!descriptor) invalid(`${path}[${index}]`, 'sparse array hole');
    if (!('value' in descriptor)) invalid(`${path}[${index}]`, 'accessor');
    if (!descriptor.enumerable) invalid(`${path}[${index}]`, 'non-enumerable array item');
    Object.defineProperty(target, key, {
      value: clone(descriptor.value, ancestors, `${path}[${index}]`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return target;
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(path: string, reason: string): never {
  throw new TypeError(`canonical own-data rejected ${path}: ${reason}`);
}
