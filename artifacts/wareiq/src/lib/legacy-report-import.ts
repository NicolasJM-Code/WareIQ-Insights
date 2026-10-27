import type { AccessLegacyReportInput } from '@workspace/api-client-react';

export const LEGACY_REPORTS_KEY = 'wareiq.own-reports';
export type LegacyCandidate = { index: number; input: AccessLegacyReportInput };
export type LegacyPreview = { candidates: LegacyCandidate[]; invalid: number; error?: string; corruptRaw?: string };

/** Parse without changing, repairing or deleting the source. Identity is never inferred. */
export function parseLegacyReports(raw: string | null): LegacyPreview {
  const empty = { candidates: [], invalid: 0 };
  if (raw === null) return empty;
  if (raw.length > 2_000_000) return { ...empty, error: 'Browser reports are too large to preview safely. Originals are unchanged.' };
  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !Array.isArray(data.reports) || data.reports.length > 1000)
      return { ...empty, error: 'Unsupported browser report format. Originals are unchanged.' };
    const candidates: LegacyCandidate[] = [];
    let invalid = 0;
    data.reports.forEach((value: unknown, index: number) => {
      if (!value || typeof value !== 'object') { invalid++; return; }
      const r = value as Record<string, unknown>;
      if (typeof r.id !== 'string' || !r.id || typeof r.createdAt !== 'string' || typeof r.updatedAt !== 'string' ||
          typeof r.section !== 'string' || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 80 ||
          typeof r.dataset !== 'string' || !r.dataset ||
          (r.description != null && (typeof r.description !== 'string' || r.description.length > 1000)) ||
          (r.sourceDefault != null && typeof r.sourceDefault !== 'string') ||
          !Array.isArray(r.fields) || !r.fields.length || r.fields.length > 100 ||
          !r.fields.every((field) => typeof field === 'string') || new Set(r.fields).size !== r.fields.length) {
        invalid++; return;
      }
      // Only definition properties cross the boundary; never reuse legacy IDs or ownership.
      candidates.push({ index, input: {
        section: r.section, name: r.name.trim(), description: (r.description as string | undefined) ?? '',
        dataset: r.dataset, fields: [...r.fields] as string[],
        ...(typeof r.sourceDefault === 'string' ? { sourceDefault: r.sourceDefault } : {}),
      } });
    });
    return { candidates, invalid };
  } catch {
    return { ...empty, error: 'Browser reports could not be read. Originals are unchanged.', corruptRaw: raw };
  }
}

export function readLegacyReports(): LegacyPreview {
  try { return parseLegacyReports(window.localStorage.getItem(LEGACY_REPORTS_KEY)); }
  catch { return { candidates: [], invalid: 0, error: 'Browser storage is blocked or unavailable. Originals are unchanged.' }; }
}

/** Discard only the exact unreadable snapshot that the user explicitly reviewed. */
export function clearCorruptLegacyReports(expectedRaw: string, confirmed: boolean): { ok: boolean; error?: string } {
  if (!confirmed || parseLegacyReports(expectedRaw).corruptRaw !== expectedRaw)
    return { ok: false, error: 'Only confirmed, unreadable browser reports can be deleted.' };
  try {
    if (window.localStorage.getItem(LEGACY_REPORTS_KEY) !== expectedRaw)
      return { ok: false, error: 'Browser reports changed since preview. Review them again before deleting.' };
    window.localStorage.removeItem(LEGACY_REPORTS_KEY);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Browser storage could not be cleared. Originals may still be present.' };
  }
}
