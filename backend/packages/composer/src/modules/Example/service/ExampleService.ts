import { ExampleEchoRequest, ExampleEchoResponse, ExampleFileUploadResponse } from "@shared/composer";
import type {
  ExampleCrudRecord,
  ExampleCrudPageRequest,
  ExampleCrudPageResponse,
  ExampleCrudAddRequest,
  ExampleCrudUpdateRequest,
  ExampleCrudDictItem,
} from "@shared/composer";
import type { ExampleService, ExampleCrudService } from "@backend/core";
import { buildDemoResponse, defaultExampleEvents } from "@backend/core";

export class DefaultExampleService implements ExampleService {
  getDemo() {
    return buildDemoResponse();
  }

  echo(payload: ExampleEchoRequest): ExampleEchoResponse {
    return {
      echo: payload.message ?? "",
      timestamp: new Date().toISOString(),
    };
  }

  async *stream() {
    yield* defaultExampleEvents();
  }

  uploadFile(filename: string, content: string, contentType: string, size: number): ExampleFileUploadResponse {
    return {
      filename,
      size,
      contentType,
      content: content.substring(0, 1000), // 只返回前1000字符作为预览
      uploadedAt: new Date().toISOString(),
    };
  }
}

// ── In-memory CRUD service ─────────────────────────────────

const ROLE_DICT: ExampleCrudDictItem[] = [
  { value: "admin", label: "管理员" },
  { value: "user", label: "普通用户" },
  { value: "editor", label: "编辑" },
  { value: "guest", label: "访客" },
];

export class DefaultExampleCrudService implements ExampleCrudService {
  private nextId = 4;
  private records: ExampleCrudRecord[] = [
    { id: 1, name: "Alice", role: "admin", score: 95 },
    { id: 2, name: "Bob", role: "user", score: 82 },
    { id: 3, name: "Charlie", role: "editor", score: 73 },
  ];

  dictRole(): ExampleCrudDictItem[] {
    return ROLE_DICT;
  }

  page(req: ExampleCrudPageRequest): ExampleCrudPageResponse {
    const { currentPage = 1, pageSize = 10, form } = req || ({} as ExampleCrudPageRequest);
    let filtered = this.records;

    if (form?.name) {
      const keyword = form.name.toLowerCase();
      filtered = filtered.filter((r) => r.name.toLowerCase().includes(keyword));
    }
    if (form?.role) {
      filtered = filtered.filter((r) => r.role === form.role);
    }

    const total = filtered.length;
    const start = (currentPage - 1) * pageSize;
    const records = filtered.slice(start, start + pageSize);

    return { records, total, currentPage, pageSize };
  }

  add(req: ExampleCrudAddRequest): ExampleCrudRecord {
    const safeReq = req || ({} as ExampleCrudAddRequest);
    const record: ExampleCrudRecord = {
      id: this.nextId++,
      name: safeReq.name ?? "",
      role: safeReq.role ?? "user",
      score: safeReq.score ?? 0,
    };
    this.records.push(record);
    return record;
  }

  update(req: ExampleCrudUpdateRequest): ExampleCrudRecord | null {
    if (!req || req.id == null) return null;
    const record = this.records.find((r) => r.id === req.id);
    if (!record) return null;
    if (req.name !== undefined) record.name = req.name;
    if (req.role !== undefined) record.role = req.role;
    if (req.score !== undefined) record.score = req.score;
    return { ...record };
  }

  remove(id: number): number {
    if (id == null) return -1;
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx === -1) return -1;
    this.records.splice(idx, 1);
    return id;
  }

  batchRemove(ids: number[]): number[] {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const removed: number[] = [];
    for (const id of ids) {
      const idx = this.records.findIndex((r) => r.id === id);
      if (idx !== -1) {
        this.records.splice(idx, 1);
        removed.push(id);
      }
    }
    return removed;
  }
}
