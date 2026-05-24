import { useEffect, useMemo, useState } from "react";

export type Theme = "e-ink" | "crt-amber" | "crt-green";
const THEME_KEY = "app-theme";

export const useTheme = () => {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "crt-amber" || stored === "crt-green" || stored === "e-ink") return stored;
    return "e-ink";
  });

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const themeClass = useMemo(() => {
    if (theme === "crt-amber") return "theme-crt-amber";
    if (theme === "crt-green") return "theme-crt-green";
    return "theme-e-ink";
  }, [theme]);

  const isCrt = theme === "crt-amber" || theme === "crt-green";

  const maskStyle = useMemo(() => {
    if (!isCrt) return {};
    const file = theme === "crt-green" ? "crt_green_mask.png" : "crt_amber_mask.png";
    return { backgroundImage: `url(/crt/${file})` };
  }, [theme, isCrt]);

  const backdropStyle = useMemo(() => {
    if (!isCrt) return {};
    const file = theme === "crt-green" ? "crt_green_bg.jpg" : "crt_amber_bg.jpg";
    return { backgroundImage: `url(/crt/${file})` };
  }, [theme, isCrt]);

  const setTheme = (next: Theme) => setThemeState(next);

  return { theme, themeClass, isCrt, maskStyle, backdropStyle, setTheme };
};
