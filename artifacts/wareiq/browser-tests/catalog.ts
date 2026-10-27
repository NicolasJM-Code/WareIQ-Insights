// The real AccessGate runs, but this isolated check never imports sample or
// customer reporting datasets. Admin allowance is independent of the catalog.
export const SECTIONS: never[] = [];
export const sectionForPath = (_path: string) => undefined;
