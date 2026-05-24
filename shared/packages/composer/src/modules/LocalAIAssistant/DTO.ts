export interface LocalFileEntry {
  label: string;
  path: string;
  isDirectory: boolean;
}

export interface ListDirectoryRequest {
  path: string;
  includeHidden?: boolean;
  maxItems?: number;
}

export interface ListDirectoryResponse {
  path: string;
  parentPath: string | null;
  entries: LocalFileEntry[];
}

export interface ReadFileRequest {
  path: string;
  maxLength?: number;
}

export interface ReadFileResponse {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}
