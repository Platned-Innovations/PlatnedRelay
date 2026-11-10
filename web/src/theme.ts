import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'relay.theme';

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return 'system';
}

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

function systemDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  applyTheme(pref);
  listeners.forEach((l) => l());
}

/** Returns the preference and the resolved (effective) theme; re-renders on change. */
export function useTheme(): { pref: ThemePref; resolved: 'light' | 'dark' } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', l);
    return () => {
      listeners.delete(l);
      mq?.removeEventListener?.('change', l);
    };
  }, []);
  const pref = getThemePref();
  const resolved = pref === 'system' ? (systemDark() ? 'dark' : 'light') : pref;
  return { pref, resolved };
}

/** Categorical chart palette (validated reference palette), stepped per mode. Order is fixed. */
const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

export function useChartTheme() {
  const { resolved } = useTheme();
  const dark = resolved === 'dark';
  return {
    series: dark ? SERIES.dark : SERIES.light,
    grid: dark ? '#2a2f39' : '#e8eaef',
    axis: dark ? '#858c9b' : '#7a8091',
    surface: dark ? '#171a20' : '#ffffff',
    cursor: dark ? 'rgba(255,255,255,0.06)' : 'rgba(16,24,40,0.05)',
  };
}
