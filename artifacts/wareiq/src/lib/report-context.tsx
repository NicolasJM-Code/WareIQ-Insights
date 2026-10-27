import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NOW_MS, type WhCode } from './data';
import { toast } from '@/hooks/use-toast';

export type RefreshInterval = '1' | '5' | '15' | '30' | 'manual';
export type RangeDays = 1 | 7 | 30 | 90;

/** Non-sensitive report preferences only. Never store credentials here. */
export interface Prefs {
  refreshInterval: RefreshInterval;
  queryTimeoutSec: number;
  defaultRange: RangeDays;
  targetPickAccuracy: number;
  targetFillRate: number;
  targetDockToStockMin: number;
}
const DEFAULT_PREFS: Prefs = { refreshInterval: '15', queryTimeoutSec: 30, defaultRange: 30, targetPickAccuracy: 99.2, targetFillRate: 97.5, targetDockToStockMin: 120 };
const KEY = 'wareiq.report-prefs.v1';

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULT_PREFS, ...p };
  } catch {
    return DEFAULT_PREFS;
  }
}

interface Ctx {
  warehouse: 'ALL' | WhCode;
  setWarehouse: (w: 'ALL' | WhCode) => void;
  range: RangeDays;
  setRange: (r: RangeDays) => void;
  refreshedAt: Date;
  refreshing: boolean;
  refresh: (silent?: boolean) => void;
  prefs: Prefs;
  setPrefs: (p: Prefs) => void;
  resetPrefs: () => void;
}
const ReportCtx = createContext<Ctx | null>(null);

export function ReportProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [warehouse, setWarehouse] = useState<'ALL' | WhCode>('ALL');
  const [range, setRange] = useState<RangeDays>(prefs.defaultRange);
  const [refreshedAt, setRefreshedAt] = useState(() => new Date());
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback((silent = false) => {
    setRefreshing(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setRefreshing(false);
      setRefreshedAt(new Date());
      if (!silent) toast({ title: 'Report refreshed', description: 'Sample data re-read in the browser. No live WMS was queried.' });
    }, 650);
  }, []);

  useEffect(() => {
    if (prefs.refreshInterval === 'manual') return;
    const id = window.setInterval(() => refresh(true), Number(prefs.refreshInterval) * 60_000);
    return () => window.clearInterval(id);
  }, [prefs.refreshInterval, refresh]);

  const setPrefs = useCallback((p: Prefs) => {
    setPrefsState(p);
    localStorage.setItem(KEY, JSON.stringify(p));
  }, []);
  const resetPrefs = useCallback(() => {
    localStorage.removeItem(KEY);
    setPrefsState(DEFAULT_PREFS);
  }, []);

  const value = useMemo(() => ({ warehouse, setWarehouse, range, setRange, refreshedAt, refreshing, refresh, prefs, setPrefs, resetPrefs }), [warehouse, range, refreshedAt, refreshing, refresh, prefs, setPrefs, resetPrefs]);
  return <ReportCtx.Provider value={value}>{children}</ReportCtx.Provider>;
}

export function useReport() {
  const c = useContext(ReportCtx);
  if (!c) throw new Error('useReport outside provider');
  return c;
}

/** Filter any dated, warehouse-tagged rows by the global selectors. */
export function useScoped<T extends { wh: WhCode; date: string }>(rows: T[]): T[] {
  const { warehouse, range } = useReport();
  return useMemo(() => {
    const from = NOW_MS - range * 86_400_000;
    return rows.filter((r) => (warehouse === 'ALL' || r.wh === warehouse) && new Date(r.date).getTime() >= from);
  }, [rows, warehouse, range]);
}

export function useWarehouseScoped<T extends { wh: WhCode }>(rows: T[]): T[] {
  const { warehouse } = useReport();
  return useMemo(() => rows.filter((r) => warehouse === 'ALL' || r.wh === warehouse), [rows, warehouse]);
}

export function useDocTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · WareIQ`;
  }, [title]);
}
