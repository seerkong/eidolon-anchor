import { existsSync, realpathSync, readFileSync, readdirSync } from "fs";
import { cp, mkdir, mkdtemp, rm } from "fs/promises";
import { createRequire } from "module";
import { tmpdir } from "os";
import path from "path";
import type { BunPlugin } from "bun";

type ResolveImportPath = (specifier: string) => string | null;

type BabelCoreModule = {
  transformAsync: (code: string, options: Record<string, unknown>) => Promise<{ code?: string | null } | null>;
};

type SolidTransformRuntime = {
  moduleName?: string;
  resolvePath?: ResolveImportPath;
};

const require = createRequire(import.meta.url);

const loadPackage = <T>(name: string, pnpmDirectoryPrefix: string, packagePath: string): T => {
  const fallback = findPnpmPackage(packagePath, pnpmDirectoryPrefix);
  if (fallback) {
    const packageJson = JSON.parse(readFileSync(path.join(fallback, "package.json"), "utf8")) as {
      main?: string;
    };
    const entry = packageJson.main ?? "index.js";
    return require(path.join(fallback, entry)) as T;
  }

  try {
    return require(name) as T;
  } catch (error) {
    throw error;
  }
};

const findPnpmPackage = (packagePath: string, directoryPrefix: string): string | null => {
  const storeDirectory = findPnpmStoreDirectory(packagePath, directoryPrefix);
  return storeDirectory ? path.join(storeDirectory, "node_modules", packagePath) : null;
};

const findBunPackage = (packagePath: string, directoryPrefix: string): string | null => {
  const workspaceRoot = path.resolve(process.cwd(), "..", "..", "..");
  const bunStore = path.join(workspaceRoot, "node_modules", ".bun");
  if (!existsSync(bunStore)) {
    return null;
  }

  const match = readdirSync(bunStore)
    .filter((entry) => entry === directoryPrefix || entry.startsWith(directoryPrefix))
    .sort()[0];

  if (!match) {
    return null;
  }

  const candidate = path.join(bunStore, match, "node_modules", packagePath);
  return existsSync(candidate) ? candidate : null;
};

const resolvePackageRoot = (specifier: string, packagePath: string, directoryPrefix: string): string | null => {
  try {
    return realpathSync(path.dirname(require.resolve(`${specifier}/package.json`)));
  } catch {
    // Optional platform packages are not always linked into the package workspace.
  }

  for (const packageRoot of [findBunPackage(packagePath, directoryPrefix), findPnpmPackage(packagePath, directoryPrefix)]) {
    if (packageRoot && existsSync(path.join(packageRoot, "package.json"))) {
      return realpathSync(packageRoot);
    }
  }

  return null;
};

const patchOpenTuiPlatformImport = (bundleText: string, platformPackageName: string): string => {
  const platformPackageDirName = JSON.stringify(platformPackageName.split("/").at(-1) ?? platformPackageName);
  const runtimeImport = `var { pathToFileURL: __eidolonPathToFileURL } = await import("node:url");
var { dirname: __eidolonDirname, join: __eidolonJoin } = await import("node:path");
var { existsSync: __eidolonExistsSync, realpathSync: __eidolonRealpathSync } = await import("node:fs");
var __eidolonExecutableRoots = [__eidolonDirname(process.execPath)];
try { __eidolonExecutableRoots.unshift(__eidolonDirname(__eidolonRealpathSync(process.execPath))); } catch {}
var __eidolonOpenTuiPlatformModule = __eidolonExecutableRoots
  .map((root) => __eidolonJoin(root, "node_modules", "@opentui", ${platformPackageDirName}, "index.ts"))
  .find((candidate) => __eidolonExistsSync(candidate));
if (!__eidolonOpenTuiPlatformModule) {
  throw new Error("Cannot find external OpenTUI platform package next to the eidolon binary: node_modules/@opentui/" + ${platformPackageDirName});
}
var module = await import(__eidolonPathToFileURL(__eidolonOpenTuiPlatformModule).href);`;
  return [
    'var module = await import(`@opentui/core-${process.platform}-${process.arch}/index.ts`);',
    'var module = await (new Function("s", "return import(s)"))("@opentui/core-" + process.platform + "-" + process.arch + "/index.ts");',
    `var module = await new Function("s", "return import(s)")("${platformPackageName}/index.ts");`,
  ].reduce((patched, pattern) => patched.replaceAll(pattern, runtimeImport), bundleText);
};

const findPnpmStoreDirectory = (packagePath: string, directoryPrefix: string): string | null => {
  for (const pnpmRoot of getPnpmRoots()) {
    if (!existsSync(pnpmRoot)) {
      continue;
    }

    const match = readdirSync(pnpmRoot)
      .filter((entry) => entry === directoryPrefix || entry.startsWith(`${directoryPrefix}_`))
      .sort()[0];

    if (!match) {
      continue;
    }

    const candidate = path.join(pnpmRoot, match, "node_modules", packagePath);
    if (existsSync(candidate)) {
      return path.join(pnpmRoot, match);
    }
  }

  return null;
};

const getPnpmRoots = (): string[] => {
  const workspaceRoot = path.resolve(process.cwd(), "..", "..", "..");
  const nodeModulesRoot = path.join(workspaceRoot, "node_modules");
  const roots = [path.join(nodeModulesRoot, ".pnpm")];

  if (existsSync(nodeModulesRoot)) {
    for (const entry of readdirSync(nodeModulesRoot)) {
      if (entry.startsWith(".old_modules-")) {
        roots.push(path.join(nodeModulesRoot, entry, ".pnpm"));
      }
    }
  }

  return roots;
};

const getDefaultExport = <T>(input: T | { default?: T }): T => {
  if (typeof input === "object" && input !== null && "default" in input && input.default !== undefined) {
    return input.default;
  }

  return input as T;
};

const sourcePath = (inputPath: string): string => {
  const searchIndex = inputPath.indexOf("?");
  const hashIndex = inputPath.indexOf("#");
  const end = [searchIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  return end === undefined ? inputPath : inputPath.slice(0, end);
};

const createSolidTransformPlugin = (): BunPlugin => {
  const babelCore = loadPackage<BabelCoreModule>("@babel/core", "@babel+core@7.28.0", path.join("@babel", "core"));
  const tsPreset = getDefaultExport(loadPackage("@babel/preset-typescript", "@babel+preset-typescript@7.27.1", path.join("@babel", "preset-typescript")));
  const moduleResolverPlugin = getDefaultExport(loadPackage("babel-plugin-module-resolver", "babel-plugin-module-resolver@5.0.2", "babel-plugin-module-resolver"));
  const solidPreset = getDefaultExport(loadPackage("babel-preset-solid", "babel-preset-solid@1.9.10", "babel-preset-solid"));

  return {
    name: "eidolon-solid-transform",
    setup: (build) => {
      build.onLoad({ filter: /[/\\]node_modules[/\\]solid-js[/\\]dist[/\\]server\.js(?:[?#].*)?$/ }, async (args) => {
        const filePath = sourcePath(args.path).replace("server.js", "solid.js");
        const code = await Bun.file(filePath).text();
        return { contents: code, loader: "js" };
      });

      build.onLoad({ filter: /[/\\]node_modules[/\\]solid-js[/\\]store[/\\]dist[/\\]server\.js(?:[?#].*)?$/ }, async (args) => {
        const filePath = sourcePath(args.path).replace("server.js", "store.js");
        const code = await Bun.file(filePath).text();
        return { contents: code, loader: "js" };
      });

      build.onLoad({ filter: /\.(js|ts)x(?:[?#].*)?$/ }, async (args) => {
        const filePath = sourcePath(args.path);
        const code = await Bun.file(filePath).text();
        const runtime = getSolidTransformRuntime();
        const moduleName = runtime.moduleName ?? "@opentui/solid";
        const resolvePath = runtime.resolvePath;
        const plugins = resolvePath
          ? [
              [
                moduleResolverPlugin,
                {
                  resolvePath(specifier: string) {
                    return resolvePath(specifier) ?? specifier;
                  },
                },
              ],
            ]
          : [];

        const transforms = await babelCore.transformAsync(code, {
          filename: filePath,
          plugins,
          presets: [
            [
              solidPreset,
              {
                moduleName,
                generate: "universal",
              },
            ],
            [tsPreset],
          ],
        });

        return {
          contents: transforms?.code ?? "",
          loader: "js",
        };
      });
    },
  };
};

const getSolidTransformRuntime = (): SolidTransformRuntime => {
  return {};
};

const solidTransformPlugin = createSolidTransformPlugin();

const outfile = process.argv.at(-1);

if (!outfile) {
  console.error("Error: expected an output path argument.");
  process.exit(1);
}

const entry = path.resolve(process.cwd(), "src", "index.ts");
const tempDir = await mkdtemp(path.join(tmpdir(), "eidolon-tui-build-"));
const bundlePath = path.join(tempDir, "bundle.mjs");
const outfileDir = path.dirname(path.resolve(outfile));
const opentuiPlatformPackage = `@opentui/core-${process.platform}-${process.arch}`;
const opentuiPlatformPackageRoot = resolvePackageRoot(
  opentuiPlatformPackage,
  path.join("@opentui", `core-${process.platform}-${process.arch}`),
  `@opentui+core-${process.platform}-${process.arch}`,
);

if (!opentuiPlatformPackageRoot) {
  await rm(tempDir, { recursive: true, force: true });
  console.error(`Error: unable to resolve ${opentuiPlatformPackage}; run bun install before building the TUI release.`);
  process.exit(1);
}

const bundleResult = await Bun.build({
  entrypoints: [entry],
  target: "bun",
  format: "esm",
  plugins: [solidTransformPlugin],
});

if (!bundleResult.success) {
  await rm(tempDir, { recursive: true, force: true });
  for (const log of bundleResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

const bundleArtifact = bundleResult.outputs.find((output) => output.kind === "entry-point") ?? bundleResult.outputs[0];
if (!bundleArtifact) {
  await rm(tempDir, { recursive: true, force: true });
  console.error("Error: Bun.build did not return an entry-point artifact.");
  process.exit(1);
}

await Bun.write(bundlePath, bundleArtifact);

const bundleText = await Bun.file(bundlePath).text();
const patchedBundleText = patchOpenTuiPlatformImport(bundleText, opentuiPlatformPackage);
if (patchedBundleText !== bundleText) {
  await Bun.write(bundlePath, patchedBundleText);
}

const compileProc = Bun.spawn(
  ["bun", "build", "--compile", "--target", "bun", "--outfile", outfile, bundlePath],
  {
    stdio: ["ignore", "inherit", "inherit"],
  }
);

const compileExitCode = await compileProc.exited;
await rm(tempDir, { recursive: true, force: true });

if (compileExitCode !== 0) {
  process.exit(compileExitCode);
}

const opentuiPlatformPackageOut = path.join(outfileDir, "node_modules", "@opentui", `core-${process.platform}-${process.arch}`);
await rm(opentuiPlatformPackageOut, { recursive: true, force: true });
await mkdir(path.dirname(opentuiPlatformPackageOut), { recursive: true });
await cp(opentuiPlatformPackageRoot, opentuiPlatformPackageOut, { recursive: true, dereference: true });
