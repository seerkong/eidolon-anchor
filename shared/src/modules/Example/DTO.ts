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
