import specification from '@assets/Pasted-1-Executive-Dashboard-Warehouse-Performance-Summary-Dai_1793099471452.txt?raw';

const sectionIds = [
  'dashboard', 'inbound', 'putaway', 'inventory', 'picking', 'outbound',
  'dispatch', 'traceability', 'stock-counts', 'labour', 'exceptions', 'settings',
] as const;

// The supplied catalogue is names only. Do not infer queries or field mappings.
export const DEFAULT_REPORT_NAMES = Object.fromEntries(
  specification.trim().split(/^\d+\.\s+/m).filter(Boolean).map((section, index) => [
    sectionIds[index],
    section.split(/\r?\n/).filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim()),
  ]),
) as Record<(typeof sectionIds)[number], string[]>;
