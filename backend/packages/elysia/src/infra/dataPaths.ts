import os from "os";
import path from "path";
import fs from "fs";
import { AppConstConfig } from "@shared/composer";
import type { BackendConfig } from "@backend/composer";

const expandTilde = (p: string) =>
  p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;

export const resolveDataDir = () => {
  const envDir = process.env[AppConstConfig.env.dataDir];
  if (envDir) return path.resolve(expandTilde(envDir));
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || os.homedir() || os.tmpdir();
    return path.join(base, AppConstConfig.kebabName);
  }
  return path.resolve(expandTilde(AppConstConfig.dataDir));
};

export const buildBackendBootstrapConfig = (dataDir: string): BackendConfig => ({
  dataDir,
  modules: {},
});
