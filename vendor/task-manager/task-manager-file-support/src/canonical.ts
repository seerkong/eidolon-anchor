import { createHash } from 'node:crypto';
import {
  canonicalOwnDataBytes,
  deepFrozenCanonicalOwnDataClone,
  type TaskArtifactBody,
  type TaskArtifactDigest,
} from 'task-manager-contract';
import { FileTaskSpaceError } from './errors.js';

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return canonicalOwnDataBytes(value);
}

export function sha256Digest(bytes: Uint8Array): TaskArtifactDigest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function parseCanonicalJson<Value>(bytes: Uint8Array, label: string): Value {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new FileTaskSpaceError('digest-mismatch', `${label} is not valid JSON: ${String(error)}`);
  }
  const canonical = canonicalJsonBytes(value);
  if (!sameBytes(bytes, canonical)) {
    throw new FileTaskSpaceError('digest-mismatch', `${label} is not canonical JSON`);
  }
  return deepFrozenCanonicalOwnDataClone(value) as Value;
}

export function taskArtifactBodyFromBytes(
  bytes: Uint8Array,
  mediaType: string,
): TaskArtifactBody {
  return Object.freeze({
    kind: 'task-artifact-body',
    digest: sha256Digest(bytes),
    mediaType,
    sizeBytes: bytes.byteLength,
    encoding: 'base64',
    data: Buffer.from(bytes).toString('base64'),
  });
}

export function verifyArtifactBody(body: TaskArtifactBody): Uint8Array {
  if (body.kind !== 'task-artifact-body' || body.encoding !== 'base64') {
    throw new FileTaskSpaceError('artifact-digest-mismatch', 'unsupported artifact body encoding');
  }
  if (body.mediaType.length === 0 || body.mediaType.trim() !== body.mediaType
    || !Number.isSafeInteger(body.sizeBytes) || body.sizeBytes < 0) {
    throw new FileTaskSpaceError('artifact-digest-mismatch', `artifact ${body.digest} has invalid metadata`);
  }
  const bytes = Uint8Array.from(Buffer.from(body.data, 'base64'));
  if (Buffer.from(bytes).toString('base64') !== body.data
    || bytes.byteLength !== body.sizeBytes
    || sha256Digest(bytes) !== body.digest) {
    throw new FileTaskSpaceError('artifact-digest-mismatch', `artifact ${body.digest} failed full digest readback`);
  }
  return bytes;
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
