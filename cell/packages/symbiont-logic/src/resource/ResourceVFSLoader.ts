import fs from "node:fs";
import path from "node:path";

import { RESOURCE_VFS_ROOT } from "@cell/symbiont-contract/resource/ResourceVFS";
import type { ResourceVfs, ResourceVfsPath } from "@cell/symbiont-contract/resource/ResourceVFS";

import { ResourceVFSOps } from "./ResourceVFS";

/**
 * 从物理文件系统构建 ResourceVFS 的 loader（terminal 入口层使用）。
 *
 * 约定：
 * - 物理根目录为 `.eidolon/`（如 `~/eidolon-anchor/.eidolon/`）。
 * - 逻辑路径 = `/.eidolon/<相对路径>`。
 * - 支持从多个物理根合并（如 workDir/.eidolon 优先、~/.eidolon 兜底）。
 */
export class ResourceVFSLoaderOps {
  /** 配置文件：物理目录下的固定文件名（本期）。 */
  static readonly CONFIG_FILE_NAMES: readonly string[] = ["runtime-config.json"];

  /**
   * 从单个物理 `.eidolon` 根加载支持的文件。
   * @param eidolonRoot 物理 `.eidolon` 目录绝对路径。
   * @returns 该根下的 ResourceVFS；根不存在返回空 VFS。
   */
  static fromEidolonRoot(eidolonRoot: string): ResourceVfs {
    const root = path.resolve(String(eidolonRoot ?? ""));
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return ResourceVFSOps.empty();
    }
    let vfs = ResourceVFSOps.empty();
    for (const fileName of ResourceVFSLoaderOps.CONFIG_FILE_NAMES) {
      const candidate = path.join(root, fileName);
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      const logicalPath = `${RESOURCE_VFS_ROOT}/${fileName}`;
      vfs = ResourceVFSOps.withFile(vfs, {
        path: logicalPath,
        content: fs.readFileSync(candidate, "utf-8"),
        source: candidate,
      });
    }
    return vfs;
  }

  /**
   * 从多个物理 `.eidolon` 根构建 VFS，按传入顺序后者覆盖前者（优先级）。
   * @param roots 优先级从低到高的物理根（如 [~/.eidolon, workDir/.eidolon]）。
   */
  static fromEidolonRoots(roots: readonly string[]): ResourceVfs {
    return ResourceVFSOps.merge(...roots.map((root) => ResourceVFSLoaderOps.fromEidolonRoot(root)));
  }

  /** 从 `{逻辑路径: 内容}` 字典构建 VFS（便于测试 / 内存构造）。 */
  static fromDict(files: Record<string, string> | Map<string, string>): ResourceVfs {
    return ResourceVFSOps.fromDict(files);
  }

  /** 从已有 VFS 中取指定逻辑路径内容。 */
  static getContent(vfs: ResourceVfs | undefined | null, path: ResourceVfsPath): string | undefined {
    return ResourceVFSOps.getContent(vfs, path);
  }
}
