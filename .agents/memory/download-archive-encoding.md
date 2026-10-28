---
name: Download archive encoding
description: HTTP encoding and embedded-preview navigation can break otherwise valid file downloads.
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

Downloads in the embedded preview should not navigate that frame to a hosted
project or login URL. Prefer fetching the same-origin archive, rejecting
redirected/HTML responses, and saving a blob, with a new-tab fallback.

**Why:** A user saw “replit.com refused to connect” when opening the direct
connector download link, even though the endpoint returned a valid ZIP in HTTP
checks. File availability and browser delivery are separate checks.

**How to apply:** Do not rely on a chat link as the only download path. Provide
the download inside the app and a fallback that opens outside the iframe. Report
that a download was requested, not that the browser definitely saved it.
