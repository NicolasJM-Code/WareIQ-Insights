// Routine authorization tests must never inherit server-side warehouse settings.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("WMS_")) {
    delete process.env[key];
  }
}
