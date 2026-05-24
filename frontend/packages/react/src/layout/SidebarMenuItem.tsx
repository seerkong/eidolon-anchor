import React, { useState } from "react";
import type { AppMenuItem } from "../router/types";

type Props = {
  menu: AppMenuItem;
  activePath: string;
  collapsed: boolean;
  depth?: number;
  onNavigate: (path: string) => void;
};

export const SidebarMenuItem: React.FC<Props> = ({ menu, activePath, collapsed, onNavigate, depth = 0 }) => {
  const [open, setOpen] = useState(true);
  const hasChildren = (menu.children?.length ?? 0) > 0;
  const isChild = depth > 0;
  const targetPath = menu.fullPath ?? menu.path;
  const isActive = targetPath ? activePath.startsWith(targetPath) : false;

  const handleClick = () => {
    if (hasChildren) {
      setOpen((v) => !v);
    } else if (targetPath) {
      onNavigate(targetPath);
    }
  };

  const buttonClasses = [
    "menu-button",
    isActive && "active",
    hasChildren && "has-children",
    isChild && "is-child",
  ].filter(Boolean).join(" ");

  return (
    <div className="menu-item">
      <button
        className={buttonClasses}
        style={collapsed ? undefined : { paddingLeft: "12px" }}
        onClick={handleClick}
      >
        {collapsed ? (
          <span className="menu-dot" />
        ) : (
          <span className="menu-label">
            {hasChildren && <span className={`menu-arrow ${open ? "open" : ""}`}>▸</span>}
            {menu.title}
          </span>
        )}
      </button>
      {hasChildren && open ? (
        <div className={`menu-children ${isChild ? "nested" : ""}`}>
          {menu.children!.map((child) => (
            <SidebarMenuItem
              key={child.fullPath}
              menu={child}
              activePath={activePath}
              collapsed={collapsed}
              depth={depth + 1}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};
