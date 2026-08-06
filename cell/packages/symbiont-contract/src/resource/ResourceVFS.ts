/**
 * ResourceVFS —— 可迁移的逻辑文件树（symbiont 层）。
 *
 * 与 sparrow 的 ResourceVFS 同构：一个以逻辑路径（PurePosixPath）为 key 的
 * 文本文件树，供上层从统一入口读取配置 / skill / agent / prompt 等资源。
 * 本包不依赖任何 cell 内部包，可整体复制到其他项目。
 */

export type ResourceVfsPath = string;

export interface ResourceVfsFile {
  /** 逻辑路径，约定以 `/.eidolon/` 开头（如 `/.eidolon/runtime-config.json`）。 */
  path: ResourceVfsPath;
  /** 文件文本内容。 */
  content: string;
  /** 来源（如物理文件路径 / "vfs" / "embedded-default"），用于诊断。 */
  source?: string;
}

/**
 * 可序列化的逻辑文件树。files 以标准化后的逻辑路径为 key。
 */
export interface ResourceVfs {
  files: Record<string, ResourceVfsFile>;
}

/** ResourceVFS 逻辑根前缀。 */
export const RESOURCE_VFS_ROOT = "/.eidolon";

/** runtime-config.json 在 VFS 中的逻辑路径。 */
export const RUNTIME_CONFIG_VFS_PATH = `${RESOURCE_VFS_ROOT}/runtime-config.json`;
