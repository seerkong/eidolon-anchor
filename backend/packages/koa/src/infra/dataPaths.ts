import path from "path";
import { AppConstConfig } from "@shared/composer";
import type { BackendConfig } from "@backend/composer";

export const resolveDataDir = () =>
  path.resolve(process.env[AppConstConfig.env.dataDir] ?? AppConstConfig.dataDir);

export const buildBackendBootstrapConfig = (dataDir: string): BackendConfig => ({
  dataDir,
  modules: {
  },
});
