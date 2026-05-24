import { computed, ref } from "vue";

export type Theme = "e-ink" | "crt-amber" | "crt-green";

const THEME_STORAGE_KEY = "toolbox-theme";

export const useTheme = () => {
  const resolveTheme = (): Theme => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "crt-amber" || stored === "crt-green" || stored === "e-ink") return stored;
    return "e-ink";
  };

  const theme = ref<Theme>(resolveTheme());

  const themeClass = computed(() => {
    if (theme.value === "crt-amber") return "theme-crt-amber";
    if (theme.value === "crt-green") return "theme-crt-green";
    return "theme-e-ink";
  });

  const isCrt = computed(() => theme.value === "crt-amber" || theme.value === "crt-green");

  const maskStyle = computed(() => {
    if (!isCrt.value) return {};
    const file = theme.value === "crt-green" ? "crt_green_mask.png" : "crt_amber_mask.png";
    return { backgroundImage: `url(/crt/${file})` };
  });

  const backdropStyle = computed(() => {
    if (!isCrt.value) return {};
    const file = theme.value === "crt-green" ? "crt_green_bg.jpg" : "crt_amber_bg.jpg";
    return { backgroundImage: `url(/crt/${file})` };
  });

  const setTheme = (next: Theme) => {
    theme.value = next;
    localStorage.setItem(THEME_STORAGE_KEY, next);
  };

  return {
    theme,
    themeClass,
    isCrt,
    maskStyle,
    backdropStyle,
    setTheme,
  };
};
