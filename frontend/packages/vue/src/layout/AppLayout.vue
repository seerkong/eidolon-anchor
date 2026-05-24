<template>
  <div class="app-shell" :class="[themeClass, { 'sidebar-collapsed': collapsed }]">
    <div v-if="isCrt" class="crt-layer backdrop" :style="backdropStyle"></div>
    <div v-if="isCrt" class="crt-layer mask" :style="maskStyle"></div>
    <div v-if="isCrt" class="crt-layer scanlines"></div>
    <div v-if="isCrt" class="crt-layer vignette"></div>
    <aside class="shell-sidebar" :class="{ collapsed }">
      <div class="brand">
        <div class="brand-name">{{ AppConstConfig.displayName }}</div>
        <small class="brand-sub">模块化工具箱框架</small>
      </div>
      <button class="menu-toggle" @click="collapsed = !collapsed">{{ collapsed ? "展开" : "收起" }}</button>
        <nav class="menu">
          <SidebarMenuItem
            v-for="menu in menus"
            :key="menu.fullPath"
            :menu="menu"
            :active-path="route.path"
            :collapsed="collapsed"
            :depth="0"
            @navigate="navigate"
          />
        </nav>
      <div class="sidebar-footer">
        <div class="sidebar-section">
          <div class="sidebar-label">主题</div>
          <div class="theme-row compact">
            <button :class="{ active: theme === 'e-ink' }" @click="setTheme('e-ink')">墨水屏</button>
            <button :class="{ active: theme === 'crt-amber' }" @click="setTheme('crt-amber')">琥珀CRT</button>
            <button :class="{ active: theme === 'crt-green' }" @click="setTheme('crt-green')">绿色CRT</button>
          </div>
        </div>
        <div class="sidebar-section">
          <div class="sidebar-label">浏览器IP:PORT</div>
          <div class="sidebar-link-box copyable" @click="copyAddress" :title="copyTip">
            <span>{{ displayAddress }}</span>
            <svg class="copy-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </div>
        </div>
      </div>
    </aside>
    <div class="shell-main">
      <header class="shell-header">
        <div class="header-title">
          <span>工具栏</span>
        </div>
        <div class="header-actions">
          <slot name="header-right" />
        </div>
      </header>
      <div class="tab-bar">
        <div
          v-for="tab in tabs"
          :key="tab.path"
          class="tab"
          :class="{ active: tab.path === route.path }"
          @click="navigate(tab.path)"
        >
          <span class="tab-title">{{ tab.title }}</span>
          <button class="tab-close" @click.stop="closeTab(tab.path)">×</button>
        </div>
        <div class="tab-actions">
          <div v-if="tabMenuOpen" class="tab-inline-menu">
            <button @click="() => { closeLeft(); tabMenuOpen = false; }">关闭左侧</button>
            <button @click="() => { closeRight(); tabMenuOpen = false; }">关闭右侧</button>
            <button @click="() => { closeOthers(); tabMenuOpen = false; }">关闭其他</button>
            <button @click="() => { closeAll(); tabMenuOpen = false; }">全部关闭</button>
          </div>
          <button class="tab-dropdown-trigger" @click="tabMenuOpen = !tabMenuOpen">关闭</button>
        </div>
      </div>
      <main class="shell-content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter, RouterView } from "vue-router";
import { AppConstConfig } from "@shared/composer";
import type { AppMenuItem } from "../router/types";
import { useTheme } from "../hooks/useTheme";
import SidebarMenuItem from "./SidebarMenuItem.vue";

const props = defineProps<{
  menus: AppMenuItem[];
}>();

const router = useRouter();
const route = useRoute();
const { theme, themeClass, isCrt, maskStyle, backdropStyle, setTheme } = useTheme();

const collapsed = ref(false);
const tabs = ref<{ title: string; path: string }[]>([]);
const tabMenuOpen = ref(false);
const displayPort = ref<string>("");
const copyTip = ref("点击复制");
const isProd = import.meta.env.PROD;
const clientHost = typeof window !== "undefined" ? window.location.hostname : "localhost";
const devPort = typeof window !== "undefined" ? window.location.port : "";

const displayAddress = computed(() => {
  const port = isProd ? displayPort.value : devPort || displayPort.value;
  const host = clientHost || "localhost";
  return port ? `${host}:${port}` : host;
});

const copyAddress = async () => {
  try {
    await navigator.clipboard.writeText(displayAddress.value);
    copyTip.value = "已复制!";
    setTimeout(() => {
      copyTip.value = "点击复制";
    }, 1500);
  } catch {
    copyTip.value = "复制失败";
    setTimeout(() => {
      copyTip.value = "点击复制";
    }, 1500);
  }
};

const addTab = () => {
  const title = (route.meta?.title as string) || route.name?.toString() || route.path;
  if (!tabs.value.find((t) => t.path === route.path)) {
    tabs.value.push({ title, path: route.path });
  }
};

const closeTab = (path: string) => {
  const idx = tabs.value.findIndex((t) => t.path === path);
  if (idx === -1) return;
  tabs.value.splice(idx, 1);
  if (path === route.path) {
    const fallback = tabs.value[idx - 1] || tabs.value[idx] || tabs.value[tabs.value.length - 1];
    router.push(fallback?.path || "/");
  }
};

const closeOthers = () => {
  tabs.value = tabs.value.filter((t) => t.path === route.path);
};
const closeLeft = () => {
  const idx = tabs.value.findIndex((t) => t.path === route.path);
  if (idx > 0) tabs.value = tabs.value.slice(idx);
};
const closeRight = () => {
  const idx = tabs.value.findIndex((t) => t.path === route.path);
  if (idx !== -1) tabs.value = tabs.value.slice(0, idx + 1);
};
const closeAll = () => {
  tabs.value = [];
  router.push("/");
};

const navigate = (fullPath: string) => router.push(fullPath);

const fetchPort = async () => {
  try {
    const res = await fetch("/api/meta", { method: "POST" });
    const data = await res.json();
    if (data?.code == 0) {
      displayPort.value = String(data.data?.port ?? "");
    }
  } catch {
    // ignore
  }
};

watch(
  () => route.path,
  () => {
    addTab();
  },
  { immediate: true }
);

const handleKeydown = (e: KeyboardEvent) => {
  if (handleClipboardHotkeys(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
};

onMounted(() => {
  if (isProd) {
    fetchPort();
  }
  window.addEventListener("keydown", handleKeydown, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeydown, true);
});

function handleClipboardHotkeys(e: KeyboardEvent): boolean {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return false;
  const key = e.key.toLowerCase();
  if (key === "c") return performCopy();
  if (key === "v") return performPaste();
  if (key === "x") return performCut();
  if (key === "a") return performSelectAll();
  if (key === "z") return performUndo(e.shiftKey ? "redo" : "undo");
  if (key === "y") return performUndo("redo");
  return false;
}

function activeEditable(): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return null;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
  if (el.isContentEditable) return el;
  return null;
}

function performCopy(): boolean {
  const selection = window.getSelection();
  const text = selection?.toString();
  if (text) {
    navigator.clipboard?.writeText(text).catch(() => {});
    return true;
  }
  const el = activeEditable();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const value = el.value;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? value.length;
    const chunk = value.slice(start, end) || value;
    navigator.clipboard?.writeText(chunk).catch(() => {});
    return true;
  }
  return false;
}

function performCut(): boolean {
  const el = activeEditable();
  if (!el) return false;
  if (performCopy()) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + el.value.slice(end);
      el.value = next;
      el.setSelectionRange(start, start);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      document.execCommand("cut");
      return true;
    }
  }
  return false;
}

function performPaste(): boolean {
  const el = activeEditable();
  if (!el) return false;
  if (!navigator.clipboard?.readText) return false;
  navigator.clipboard
    .readText()
    .then((text) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const start = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? start;
        el.setRangeText(text, start, end, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (el.isContentEditable) {
        document.execCommand("insertText", false, text);
      }
    })
    .catch(() => {});
  return true;
}

function performSelectAll(): boolean {
  const el = activeEditable();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select();
    return true;
  }
  if (el?.isContentEditable) {
    document.execCommand("selectAll");
    return true;
  }
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(document.body);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  return false;
}

function performUndo(action: "undo" | "redo"): boolean {
  document.execCommand(action);
  return true;
}
</script>
