import fs from "fs/promises";
import path from "path";

export const ensureDir = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

export const ensureDirForFile = async (filePath: string) => ensureDir(path.dirname(filePath));
