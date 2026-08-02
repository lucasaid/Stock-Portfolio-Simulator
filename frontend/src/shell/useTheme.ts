import { useEffect } from 'react';
import type { LookAndFeelSettings } from '../api/types';

/** Applies the stored look & feel to the document root (spec §6.1). */
export function applyTheme(look: Pick<LookAndFeelSettings, 'theme' | 'accent'>): void {
  const prefersDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const resolved = look.theme === 'system' ? (prefersDark ? 'dark' : 'light') : look.theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.setProperty('--accent', look.accent);
}

export function useTheme(look: LookAndFeelSettings | undefined): void {
  useEffect(() => {
    if (look) applyTheme(look);
  }, [look]);
}
