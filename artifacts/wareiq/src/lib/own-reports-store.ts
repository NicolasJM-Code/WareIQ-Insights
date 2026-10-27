// Own report DEFINITIONS saved in this browser's localStorage (versioned).
// Only names, dataset ids and field keys are stored: never operational rows,
// never credentials. This is not tied to a signed-in user.
import { useSyncExternalStore } from 'react';
import { SECTION_IDS, type SectionId } from './report-catalog';

export const OWN_REPORTS_KEY = 'wareiq.own-reports';
const VERSION = 1;

export interface OwnReport { id: string; section: SectionId; name: string; description: string; dataset: string; fields: string[]; createdAt: string; updatedAt: string; sourceDefault?: string }
export type OwnReportInput = Pick<OwnReport, 'section' | 'name' | 'description' | 'dataset' | 'fields' | 'sourceDefault'>;

interface State { status: 'ok' | 'corrupt' | 'unavailable'; reports: OwnReport[]; invalid: unknown[]; detail?: string }
export type SaveResult = { ok: true; report?: OwnReport } | { ok: false; error: string };

const isStr = (v: unknown): v is string => typeof v === 'string';
export const NAME_MAX = 80;

function validate(x: unknown): OwnReport | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (!isStr(o.id) || !o.id) return null;
  if (!isStr(o.section) || !(SECTION_IDS as string[]).includes(o.section)) return null;
  if (!isStr(o.name) || !o.name.trim() || o.name.length > NAME_MAX) return null;
  if (!isStr(o.dataset) || !o.dataset) return null;
  if (!Array.isArray(o.fields) || !o.fields.length || !o.fields.every(isStr)) return null;
  if (!isStr(o.createdAt) || !isStr(o.updatedAt)) return null;
  if (o.description != null && !isStr(o.description)) return null;
  if (o.sourceDefault != null && !isStr(o.sourceDefault)) return null;
  return {
    id: o.id, section: o.section as SectionId, name: o.name, description: (o.description as string | undefined) ?? '', dataset: o.dataset,
    fields: [...new Set(o.fields as string[])], createdAt: o.createdAt, updatedAt: o.updatedAt, sourceDefault: o.sourceDefault as string | undefined,
  };
}

function load(): State {
  let raw: string | null;
  try {
    raw = localStorage.getItem(OWN_REPORTS_KEY);
  } catch {
    return { status: 'unavailable', reports: [], invalid: [], detail: 'Browser storage is blocked, so own reports cannot be read or saved.' };
  }
  if (raw == null) return { status: 'ok', reports: [], invalid: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    const p = parsed as { version?: unknown; reports?: unknown };
    if (p.version !== VERSION) return { status: 'corrupt', reports: [], invalid: [], detail: `Stored own reports use an unsupported format (version ${String(p.version)}).` };
    if (!Array.isArray(p.reports)) throw new Error('reports missing');
    const reports: OwnReport[] = [];
    const invalid: unknown[] = [];
    for (const r of p.reports) {
      const v = validate(r);
      if (v) reports.push(v); else invalid.push(r);
    }
    return { status: 'ok', reports, invalid };
  } catch {
    return { status: 'corrupt', reports: [], invalid: [], detail: 'Stored own reports could not be read. They have been left untouched.' };
  }
}

let state: State = typeof window === 'undefined' ? { status: 'ok', reports: [], invalid: [] } : load();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === OWN_REPORTS_KEY || e.key === null) { state = load(); emit(); }
  });
}

function persist(next: OwnReport[]): SaveResult {
  if (state.status === 'corrupt') return { ok: false, error: 'Saved reports in this browser are unreadable. Resolve that first; nothing was saved.' };
  if (state.status === 'unavailable') return { ok: false, error: 'Browser storage is unavailable (private mode or blocked). Nothing was saved.' };
  try {
    // Invalid entries we could not parse are written back untouched, never silently dropped.
    localStorage.setItem(OWN_REPORTS_KEY, JSON.stringify({ version: VERSION, reports: [...next, ...state.invalid] }));
  } catch (e) {
    const quota = e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22);
    return { ok: false, error: quota ? 'Browser storage is full. Nothing was saved; delete some reports or free space.' : 'The browser refused to write to storage. Nothing was saved.' };
  }
  state = { ...state, reports: next };
  emit();
  return { ok: true };
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

export function createReport(input: OwnReportInput): SaveResult {
  const now = new Date().toISOString();
  const report: OwnReport = { ...input, name: input.name.trim(), description: input.description.trim(), id: newId(), createdAt: now, updatedAt: now };
  const res = persist([...state.reports, report]);
  return res.ok ? { ok: true, report } : res;
}
export function updateReport(id: string, input: OwnReportInput): SaveResult {
  const cur = state.reports.find((r) => r.id === id);
  if (!cur) return { ok: false, error: 'This report no longer exists in this browser.' };
  const report: OwnReport = { ...cur, ...input, name: input.name.trim(), description: input.description.trim(), updatedAt: new Date().toISOString() };
  const res = persist(state.reports.map((r) => (r.id === id ? report : r)));
  return res.ok ? { ok: true, report } : res;
}
export function duplicateReport(id: string): SaveResult {
  const cur = state.reports.find((r) => r.id === id);
  if (!cur) return { ok: false, error: 'This report no longer exists in this browser.' };
  const name = `${cur.name} (copy)`.slice(0, NAME_MAX);
  return createReport({ section: cur.section, name, description: cur.description, dataset: cur.dataset, fields: cur.fields, sourceDefault: cur.sourceDefault });
}
export function deleteReport(id: string): SaveResult {
  return persist(state.reports.filter((r) => r.id !== id));
}
/** Explicit, user-confirmed removal of unreadable stored data. */
export function clearCorruptStore(): SaveResult {
  try {
    localStorage.removeItem(OWN_REPORTS_KEY);
  } catch {
    return { ok: false, error: 'The browser refused to clear storage.' };
  }
  state = { status: 'ok', reports: [], invalid: [] };
  emit();
  return { ok: true };
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snap = () => state;
export function useOwnReportsState() {
  return useSyncExternalStore(subscribe, snap, snap);
}
