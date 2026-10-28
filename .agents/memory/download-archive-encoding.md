---
name: Download archive encoding
description: Vite may label gzip archives as HTTP content encoding and cause browsers to decode the download automatically.
---

Prefer ZIP for downloadable source bundles, or explicitly verify HTTP encoding
when serving `.gz` archives through the Vite preview.

**Why:** The preview served a `.tar.gz` file with `Content-Encoding: gzip`.
The HTTP client transparently decoded it into a plain tar archive, despite the
download filename retaining `.tar.gz`. An archive that is valid on disk can
therefore reach the user with the wrong format.

**How to apply:** Validate the bytes downloaded through the actual artifact
proxy, not only the generated file. Check archive integrity and the exact file
allowlist; do not assume a successful HTTP response proves a usable download.
