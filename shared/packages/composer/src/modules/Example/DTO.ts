export interface ExampleEchoRequest {
  message: string;
}

export interface ExampleEchoResponse {
  echo: string;
  timestamp: string;
}

export interface ExampleSSEEvent {
  event: string;
  data: string;
}

export interface ExampleDemoResponse {
  message: string;
  timestamp: string;
}

export interface ExampleFileUploadResponse {
  filename: string;
  size: number;
  contentType: string;
  content: string;
  uploadedAt: string;
}

// ── CRUD DTOs ──────────────────────────────────────────────

export interface ExampleCrudRecord {
  id: number;
  name: string;
  role: string;
  score: number;
}

export interface ExampleCrudPageRequest {
  currentPage: number;
  pageSize: number;
  form?: {
    name?: string;
    role?: string;
  };
}

export interface ExampleCrudPageResponse {
  records: ExampleCrudRecord[];
  total: number;
  currentPage: number;
  pageSize: number;
}

export interface ExampleCrudAddRequest {
  name: string;
  role: string;
  score: number;
}

export interface ExampleCrudUpdateRequest {
  id: number;
  name?: string;
  role?: string;
  score?: number;
}

export interface ExampleCrudDeleteRequest {
  id: number;
}

export interface ExampleCrudBatchDeleteRequest {
  ids: number[];
}

export interface ExampleCrudDictItem {
  value: string;
  label: string;
}
