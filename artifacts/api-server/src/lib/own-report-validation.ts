import { sectionDatasets } from "./access-catalog";

/** Shared by ordinary saves and legacy imports; the browser is never authoritative. */
export function reportDefinitionError(input: {
  section: string; dataset: string; fields: string[]; name: string; sourceDefault?: string;
}, reportIds: string[], ownReportSections: string[] = []): { status: number; message: string } | undefined {
  if (!ownReportSections.includes(input.section))
    return { status: 403, message: "Your role does not allow own reports in this section." };
  // Own-property checks also reject object-prototype names in untrusted input.
  const datasets = Object.hasOwn(sectionDatasets, input.section) ? sectionDatasets[input.section] : undefined;
  const fields = datasets && Object.hasOwn(datasets, input.dataset) ? datasets[input.dataset] : undefined;
  if (!fields || !input.fields.length || input.fields.some((field) => !fields.includes(field)) ||
      new Set(input.fields).size !== input.fields.length)
    return { status: 400, message: "Use only fields from the selected dataset within this section." };
  if (!input.name.trim())
    return { status: 400, message: "Report name is required." };
  if (input.sourceDefault && !reportIds.includes(input.sourceDefault))
    return { status: 403, message: "You do not have access to the source report." };
  return undefined;
}
