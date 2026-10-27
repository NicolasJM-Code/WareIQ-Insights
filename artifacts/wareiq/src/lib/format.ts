import { NOW_MS } from './data';

const nf = new Intl.NumberFormat('en-GB');
export const num = (n: number) => nf.format(Math.round(n));
export const dec = (n: number, d = 1) => n.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (n: number, d = 1) => (Number.isFinite(n) ? `${dec(n, d)}%` : '—');
export const gbp = (n: number) => n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
export const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');
export const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const time = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const daysUntil = (iso: string) => Math.round((new Date(iso).getTime() - NOW_MS) / 86_400_000);
export const mins = (m: number | null) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${Math.round(m)}m`);

export interface CsvColumn<T> { label: string; value: (row: T) => string | number | null | undefined }
export function downloadCsv<T>(filename: string, columns: CsvColumn<T>[], rows: T[]) {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    `# WareIQ SAMPLE DATA export - not from a live WMS - generated ${new Date().toISOString()}`,
    columns.map((c) => esc(c.label)).join(','),
    ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Bucket dated rows into N daily/weekly bins ending today. */
export function bucket<T extends { date: string }>(rows: T[], rangeDays: number, value: (r: T) => number = () => 1) {
  const bins = rangeDays <= 1 ? 24 : rangeDays <= 7 ? 7 : rangeDays <= 30 ? 30 : 13;
  const span = (rangeDays * 86_400_000) / bins;
  const start = NOW_MS - rangeDays * 86_400_000;
  const out = Array.from({ length: bins }, (_, i) => ({ label: labelFor(start + i * span, rangeDays), value: 0 }));
  for (const r of rows) {
    const idx = Math.floor((new Date(r.date).getTime() - start) / span);
    if (idx >= 0 && idx < bins) out[idx].value += value(r);
  }
  return out;
}
function labelFor(ms: number, range: number) {
  const d = new Date(ms);
  if (range <= 1) return `${String(d.getHours()).padStart(2, '0')}:00`;
  if (range <= 30) return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  return `w/c ${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`;
}
