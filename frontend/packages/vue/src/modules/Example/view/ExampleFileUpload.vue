<template>
  <div class="card">
    <h3 class="section-title">文件上传示例</h3>
    
    <div class="grid two" style="align-items:center;">
      <div>
        <label>选择文件</label>
        <input type="file" @change="handleFile" accept="*/*" />
      </div>
      
      <div>
        <label>操作</label>
        <div style="display:flex; gap:8px; align-items:center;">
          <button @click="uploadFile" :disabled="!selectedFile || uploading">
            {{ uploading ? "上传中..." : "上传文件" }}
          </button>
          <small v-if="selectedFile" style="color:var(--muted);">
            {{ selectedFile.name }} ({{ formatSize(selectedFile.size) }})
          </small>
        </div>
      </div>
    </div>

    <div v-if="error" class="alert error" style="margin-top:10px;">
      {{ error }}
    </div>

    <div v-if="uploadResult" class="card" style="margin-top:10px; background:color-mix(in srgb, var(--bg) 75%, var(--border) 15%);">
      <div class="section-title">上传结果</div>
      <div class="grid two">
        <div>
          <label>文件名</label>
          <div class="badge accent">{{ uploadResult.filename }}</div>
        </div>
        <div>
          <label>大小</label>
          <div class="badge muted">{{ formatSize(uploadResult.size) }}</div>
        </div>
        <div>
          <label>类型</label>
          <div class="badge muted">{{ uploadResult.contentType }}</div>
        </div>
        <div>
          <label>上传时间</label>
          <div class="badge muted">{{ formatDate(uploadResult.uploadedAt) }}</div>
        </div>
      </div>
      
      <div style="margin-top:10px;">
        <label>内容预览 (前1000字符)</label>
        <pre style="white-space:pre-wrap; font-size:13px; background:#0c1523; padding:10px; border-radius:8px; border:1px solid var(--border); max-height:300px; overflow:auto;">{{ uploadResult.content }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { type ExampleFileUploadResponse } from "@frontend/core";
import { useFrontendRuntime } from "@frontend/vue/hooks/use-runtime";

const runtime = useFrontendRuntime();
const api = runtime.actorMesh.modules.Example.exampleApi;

const selectedFile = ref<File | null>(null);
const uploading = ref(false);
const error = ref("");
const uploadResult = ref<ExampleFileUploadResponse | null>(null);

function handleFile(e: Event) {
  const target = e.target as HTMLInputElement;
  selectedFile.value = target.files?.[0] ?? null;
  error.value = "";
  uploadResult.value = null;
}

async function uploadFile() {
  if (!selectedFile.value) return;
  
  uploading.value = true;
  error.value = "";
  uploadResult.value = null;
  
  try {
    const result = await api.uploadFile(runtime, selectedFile.value);
    uploadResult.value = result;
  } catch (err: any) {
    error.value = err.message || "上传失败";
  } finally {
    uploading.value = false;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleString();
}
</script>
