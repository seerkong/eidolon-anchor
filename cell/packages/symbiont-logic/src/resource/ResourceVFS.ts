import type {
  ResourceVfs,
  ResourceVfsFile,
  ResourceVfsPath,
} from "@cell/symbiont-contract/resource/ResourceVFS";

/** 规范化 VFS 逻辑路径：确保以 `/` 开头、去掉尾部 `/`（根除外）、合并重复斜杠、统一分隔符。 */
export function normalizeVfsPath(path: ResourceVfsPath): ResourceVfsPath {
  const raw = String(path ?? "").trim();
  if (!raw || raw === "/") return "/";
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  const normalizedSep = withLeading.replace(/\\/g, "/");
  const collapsed = normalizedSep.replace(/\/{2,}/g, "/");
  const withoutTrailing = collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
  return withoutTrailing;
}

/** ResourceVFS 上的纯操作：不可变构建 / 查询。 */
export class ResourceVFSOps {
  static empty(): ResourceVfs {
    return { files: {} };
  }

  static withFile(vfs: ResourceVfs, params: { path: ResourceVfsPath; content: string; source?: string }): ResourceVfs {
    const normalized = normalizeVfsPath(params.path);
    const existing = vfs.files[normalized];
    return {
      files: {
        ...vfs.files,
        [normalized]: {
          path: normalized,
          content: params.content,
          source: params.source ?? existing?.source,
        },
      },
    };
  }

  static fromDict(files: Record<string, string> | Map<string, string>): ResourceVfs {
    let vfs = ResourceVFSOps.empty();
    for (const [path, content] of files instanceof Map ? files : Object.entries(files)) {
      vfs = ResourceVFSOps.withFile(vfs, { path, content });
    }
    return vfs;
  }

  static merge(...vfss: Array<ResourceVfs | undefined | null>): ResourceVfs {
    let merged = ResourceVFSOps.empty();
    for (const vfs of vfss) {
      if (!vfs) continue;
      for (const file of Object.values(vfs.files)) {
        merged = ResourceVFSOps.withFile(merged, { path: file.path, content: file.content, source: file.source });
      }
    }
    return merged;
  }

  static get(vfs: ResourceVfs | undefined | null, path: ResourceVfsPath): ResourceVfsFile | undefined {
    if (!vfs) return undefined;
    return vfs.files[normalizeVfsPath(path)];
  }

  static getContent(vfs: ResourceVfs | undefined | null, path: ResourceVfsPath): string | undefined {
    return ResourceVFSOps.get(vfs, path)?.content;
  }

  static listPaths(vfs: ResourceVfs | undefined | null): ResourceVfsPath[] {
    if (!vfs) return [];
    return Object.keys(vfs.files).sort();
  }
}
