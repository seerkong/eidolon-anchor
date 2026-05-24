import React, { useState } from "react";
import { type ExampleFileUploadResponse } from "@frontend/core";
import { useFrontendRuntime } from "../../../runtime";

export default function ExampleFileUpload() {
  const runtime = useFrontendRuntime();
  const api = runtime.actorMesh.modules.Example.exampleApi;

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [uploadResult, setUploadResult] = useState<ExampleFileUploadResponse | null>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedFile(e.target.files?.[0] ?? null);
    setError("");
    setUploadResult(null);
  };

  const uploadFile = async () => {
    if (!selectedFile) return;

    setUploading(true);
    setError("");
    setUploadResult(null);

    try {
      const result = await api.uploadFile(runtime, selectedFile);
      setUploadResult(result);
    } catch (err: any) {
      setError(err.message || "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const formatDate = (isoString: string): string => {
    return new Date(isoString).toLocaleString();
  };

  return (
    <div className="card">
      <h3 className="section-title">文件上传示例</h3>

      <div className="grid two" style={{ alignItems: "center" }}>
        <div>
          <label>选择文件</label>
          <input type="file" onChange={handleFile} accept="*/*" />
        </div>

        <div>
          <label>操作</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={uploadFile} disabled={!selectedFile || uploading}>
              {uploading ? "上传中..." : "上传文件"}
            </button>
            {selectedFile && (
              <small style={{ color: "var(--muted)" }}>
                {selectedFile.name} ({formatSize(selectedFile.size)})
              </small>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="alert error" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      {uploadResult && (
        <div
          className="card"
          style={{
            marginTop: 10,
            background: "color-mix(in srgb, var(--bg) 75%, var(--border) 15%)",
          }}
        >
          <div className="section-title">上传结果</div>
          <div className="grid two">
            <div>
              <label>文件名</label>
              <div className="badge accent">{uploadResult.filename}</div>
            </div>
            <div>
              <label>大小</label>
              <div className="badge muted">{formatSize(uploadResult.size)}</div>
            </div>
            <div>
              <label>类型</label>
              <div className="badge muted">{uploadResult.contentType}</div>
            </div>
            <div>
              <label>上传时间</label>
              <div className="badge muted">{formatDate(uploadResult.uploadedAt)}</div>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <label>内容预览 (前1000字符)</label>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                fontSize: 13,
                background: "#0c1523",
                padding: 10,
                borderRadius: 8,
                border: "1px solid var(--border)",
                maxHeight: 300,
                overflow: "auto",
              }}
            >
              {uploadResult.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
