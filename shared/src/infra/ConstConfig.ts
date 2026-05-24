export const AppConstConfig = {
  kebabName: "eidolon-anchor",
  pascalName: "EidolonAnchor",
  displayName: "Eidolon Anchor",
  // Default POSIX data dir; Windows will override via LOCALAPPDATA fallback in runtime helpers.
  dataDir: "/var/tmp/eidolon-anchor",
  backendBinaryName: "eidolon-anchor-backend",
  desktopBinaryName: "eidolon-anchor.bin",
  appBundleName: "EidolonAnchor.app",
  launcherName: "EidolonAnchor",
  env: {
    dataDir: "APP_DATA_DIR",
    frontendDir: "APP_FRONTEND_DIR",
    logFile: "APP_LOG_FILE",
    readyFile: "APP_READY_FILE",
    resourcesDir: "APP_RESOURCES",
    desktopDevPort: "APP_DESKTOP_DEV_PORT",
  },
};

export type AppConstConfigType = typeof AppConstConfig;
