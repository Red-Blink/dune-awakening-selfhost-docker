import { useEffect, useState } from "react";
import { DEFAULT_THEME_ID, THEME_STORAGE_KEY } from "../themes/themeBoot";
import type { DuneSkinProfile } from "./skinTypes";
import {
  ACTIVE_SKIN_STORAGE_KEY,
  applySkinProfile,
  isDefaultSkin,
  isLayoutEditMode,
  loadActiveSkin,
   setLayoutEditMode,
  SKIN_CHANGED_EVENT,
  SKIN_LAYOUT_EDIT_MODE_EVENT,
} from "./skinEngine";

export function useSkinConfig(): [DuneSkinProfile, boolean, (enabled: boolean) => void] {
  const [skin, setSkin] = useState<DuneSkinProfile>(() => loadActiveSkin());
  const [editMode, setEditModeState] = useState<boolean>(() => isLayoutEditMode());

  useEffect(() => {
    // Apply on initial mount if a non-default skin is stored
    const current = loadActiveSkin();
    if (!isDefaultSkin(current)) {
      applySkinProfile(current);
    }
    setSkin(current);

    const onSkinChange = () => {
      const next = loadActiveSkin();
      setSkin(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === ACTIVE_SKIN_STORAGE_KEY || event.key === THEME_STORAGE_KEY || event.key === null) {
        const next = loadActiveSkin();
        applySkinProfile(next);
        setSkin(next);
      }
    };
    const onEditMode = () => {
      setEditModeState(isLayoutEditMode());
    };

    // Synchronize if user picks a built-in theme via the standard ThemeLauncher while a custom skin is active
    const themeObserver = new MutationObserver(() => {
      const domTheme = document.documentElement.dataset.theme;
      if (domTheme && domTheme.startsWith("skin-")) return;
      const active = loadActiveSkin();
      if (isDefaultSkin(active)) return;
      const nextBaseTheme = domTheme || DEFAULT_THEME_ID;
      if (active.customColors.enabled || active.baseThemeId !== nextBaseTheme) {
        const synced: DuneSkinProfile = {
          ...active,
          baseThemeId: nextBaseTheme,
          customColors: {
            ...active.customColors,
            enabled: false,
          },
        };
        try {
          window.localStorage.setItem(ACTIVE_SKIN_STORAGE_KEY, JSON.stringify(synced));
        } catch {
          // ignore
        }
        setSkin(synced);
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    window.addEventListener(SKIN_CHANGED_EVENT, onSkinChange);
    window.addEventListener("storage", onStorage);
    window.addEventListener(SKIN_LAYOUT_EDIT_MODE_EVENT, onEditMode);
    return () => {
      themeObserver.disconnect();
      window.removeEventListener(SKIN_CHANGED_EVENT, onSkinChange);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SKIN_LAYOUT_EDIT_MODE_EVENT, onEditMode);
    };
  }, []);

  return [skin, editMode, setLayoutEditMode];
}
