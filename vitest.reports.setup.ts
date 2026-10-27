import { rmSync } from "node:fs";

export default function cleanupReportIsolationRegistry() {
  const directory = process.env.WAREIQ_REPORT_TEST_REGISTRY;
  if (!directory) {
    throw new Error("Report test isolation registry was not configured");
  }

  return () => rmSync(directory, { recursive: true, force: true });
}
