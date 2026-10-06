import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { fsyncDirectory, fsyncDirectorySync } from "../src/runtime/durableDirectoryFsync";

describe("durable directory fsync", () => {
  test("does not fail when the platform cannot sync a directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eidolon-dir-fsync-"));
    try {
      await expect(fsyncDirectory(directory)).resolves.toBeUndefined();
      expect(() => fsyncDirectorySync(directory)).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
