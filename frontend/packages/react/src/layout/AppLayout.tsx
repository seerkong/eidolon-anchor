import React, { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useMatches, useNavigate } from "react-router-dom";
import { AppConstConfig } from "@shared/composer";
import { useTheme } from "../hooks/useTheme";
import type { AppMenuItem } from "../router/types";
import { SidebarMenuItem } from "./SidebarMenuItem";

const OutletComponent = Outlet as unknown as React.ComponentType;

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
  if (!el || !navigator.clipboard?.readText) return false;
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

export const AppLayout: React.FC<{ menus: AppMenuItem[] }> = ({ menus }) => {
  const location = useLocation();
  const matches = useMatches();
  const navigate = useNavigate();
  const { theme, themeClass, isCrt, maskStyle, backdropStyle, setTheme } = useTheme();
  const isProd = import.meta.env.PROD;
  const clientHost = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const devPort = typeof window !== "undefined" ? window.location.port : "";
  const [collapsed, setCollapsed] = useState(false);
  const [tabs, setTabs] = useState<{ title: string; path: string }[]>([]);
  const [displayPort, setDisplayPort] = useState("");
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const [copyTip, setCopyTip] = useState("点击复制");

  const displayAddress = useMemo(() => {
    const port = isProd ? displayPort : devPort || displayPort;
    const host = clientHost || "localhost";
    return port ? `${host}:${port}` : host;
  }, [clientHost, devPort, displayPort, isProd]);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(displayAddress);
      setCopyTip("已复制!");
      setTimeout(() => setCopyTip("点击复制"), 1500);
    } catch {
      setCopyTip("复制失败");
      setTimeout(() => setCopyTip("点击复制"), 1500);
    }
  };

  const currentTitle = useMemo(() => {
    const last = matches[matches.length - 1];
    return (last?.handle as any)?.title ?? last?.pathname ?? location.pathname;
  }, [matches, location.pathname]);

  const addTab = () => {
    setTabs((prev) => {
      if (prev.some((t) => t.path === location.pathname)) return prev;
      return [...prev, { title: currentTitle, path: location.pathname }];
    });
  };

  useEffect(() => {
    addTab();
  }, [location.pathname, currentTitle]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (handleClipboardHotkeys(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const closeTab = (path: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== path);
      if (path === location.pathname) {
        const fallback = next[next.length - 1];
        navigate(fallback?.path || "/");
      }
      return next;
    });
  };

  const closeOthers = () => setTabs((prev) => prev.filter((t) => t.path === location.pathname));
  const closeLeft = () =>
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === location.pathname);
      if (idx <= 0) return prev;
      return prev.slice(idx);
    });
  const closeRight = () =>
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === location.pathname);
      if (idx === -1) return prev;
      return prev.slice(0, idx + 1);
    });
  const closeAll = () => {
    setTabs([]);
    navigate("/");
  };

  const handleNav = (fullPath: string) => navigate(fullPath);

  useEffect(() => {
    if (!isProd) return;
    (async () => {
      try {
        const res = await fetch("/api/meta", { method: "POST" });
        const data = await res.json();
        if (data?.code == 0) setDisplayPort(String(data.data?.port ?? ""));
      } catch {
        // ignore
      }
    })();
  }, [isProd]);

  return (
    <div className={`app-shell ${themeClass} ${collapsed ? "sidebar-collapsed" : ""}`}>
      {isCrt && <div className="crt-layer backdrop" style={backdropStyle} />}
      {isCrt && <div className="crt-layer mask" style={maskStyle} />}
      {isCrt && <div className="crt-layer scanlines" />}
      {isCrt && <div className="crt-layer vignette" />}
      <aside className={`shell-sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="brand">
          <div className="brand-name">{AppConstConfig.displayName}</div>
          <small className="brand-sub">模块化工具箱框架</small>
        </div>
        <button className="menu-toggle" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? "展开" : "收起"}
        </button>
        <nav className="menu">
          {menus.map((menu) => (
            <SidebarMenuItem key={menu.fullPath} menu={menu} activePath={location.pathname} collapsed={collapsed} depth={0} onNavigate={handleNav} />
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-section">
            <div className="sidebar-label">主题</div>
            <div className="theme-row compact">
              <button className={theme === "e-ink" ? "active" : ""} onClick={() => setTheme("e-ink")}>
                墨水屏
              </button>
              <button className={theme === "crt-amber" ? "active" : ""} onClick={() => setTheme("crt-amber")}>
                琥珀CRT
              </button>
              <button className={theme === "crt-green" ? "active" : ""} onClick={() => setTheme("crt-green")}>
                绿色CRT
              </button>
            </div>
          </div>
          <div className="sidebar-section">
            <div className="sidebar-label">浏览器IP:PORT</div>
            <div className="sidebar-link-box copyable" onClick={copyAddress} title={copyTip}>
              <span>{displayAddress}</span>
              <svg className="copy-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </div>
          </div>
        </div>
      </aside>
      <div className="shell-main">
        <header className="shell-header">
          <div className="header-title">
            <span>工具栏</span>
          </div>
          <div className="header-actions"></div>
        </header>
        <div className="tab-bar">
          {tabs.map((tab) => (
            <div key={tab.path} className={`tab ${tab.path === location.pathname ? "active" : ""}`} onClick={() => navigate(tab.path)}>
              <span className="tab-title">{tab.title}</span>
              <button className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(tab.path); }}>
                ×
              </button>
            </div>
          ))}
          <div className="tab-actions">
            {tabMenuOpen && (
              <div className="tab-inline-menu">
                <button onClick={() => { closeLeft(); setTabMenuOpen(false); }}>关闭左侧</button>
                <button onClick={() => { closeRight(); setTabMenuOpen(false); }}>关闭右侧</button>
                <button onClick={() => { closeOthers(); setTabMenuOpen(false); }}>关闭其他</button>
                <button onClick={() => { closeAll(); setTabMenuOpen(false); }}>全部关闭</button>
              </div>
            )}
            <button className="tab-dropdown-trigger" onClick={() => setTabMenuOpen((v) => !v)}>
              关闭
            </button>
          </div>
        </div>
        <main className="shell-content">
          <OutletComponent />
        </main>
      </div>
    </div>
  );
};
