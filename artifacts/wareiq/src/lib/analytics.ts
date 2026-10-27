import { SECTION_IDS, type SectionId } from './report-catalog';

type AnalyticsData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void;
    };
  }
}

export function safeAnalyticsSection(section: unknown): SectionId | undefined {
  return typeof section === 'string' && SECTION_IDS.includes(section as SectionId)
    ? section as SectionId
    : undefined;
}

/** Analytics is optional and must never affect the action being measured. */
export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === 'undefined') return;
  try {
    window.umami?.track(name, data);
  } catch {
    // Tracking failures are intentionally ignored.
  }
}
