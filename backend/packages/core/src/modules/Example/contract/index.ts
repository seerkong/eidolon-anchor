import { ExampleDemoResponse, ExampleEchoRequest, ExampleEchoResponse, ExampleSSEEvent, ExampleFileUploadResponse } from "@shared/composer";
import type {
  ExampleCrudRecord,
  ExampleCrudPageRequest,
  ExampleCrudPageResponse,
  ExampleCrudAddRequest,
  ExampleCrudUpdateRequest,
  ExampleCrudDictItem,
} from "@shared/composer";

export interface ExampleService {
  getDemo(): ExampleDemoResponse;
  echo(payload: ExampleEchoRequest): ExampleEchoResponse;
  stream(): AsyncIterable<ExampleSSEEvent>;
  uploadFile(filename: string, content: string, contentType: string, size: number): ExampleFileUploadResponse;
}

export interface ExampleCrudService {
  dictRole(): ExampleCrudDictItem[];
  page(req: ExampleCrudPageRequest): ExampleCrudPageResponse;
  add(req: ExampleCrudAddRequest): ExampleCrudRecord;
  update(req: ExampleCrudUpdateRequest): ExampleCrudRecord | null;
  remove(id: number): number;
  batchRemove(ids: number[]): number[];
}

export * from "./Runtime";
