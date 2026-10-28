import { useState } from 'react';

const filename = 'wareiq-openvpn-connector.zip';

export function ConnectorDownload() {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const href = `${import.meta.env.BASE_URL}downloads/${filename}`;

  const download = async () => {
    if (pending) return;
    setPending(true); setStatus(null); setError(false);
    try {
      // Fetch inside the authenticated preview instead of navigating its iframe.
      // Never save a redirected sign-in/error page as a connector ZIP.
      const response = await fetch(href, { credentials: 'same-origin', redirect: 'error' });
      if (!response.ok || response.redirected) throw new Error('Download unavailable');
      const bytes = await response.arrayBuffer();
      const signature = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4));
      if (signature.length !== 4 || signature[0] !== 0x50 || signature[1] !== 0x4b ||
          signature[2] !== 0x03 || signature[3] !== 0x04) throw new Error('Not a ZIP');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Delay revocation so the browser has time to start saving the file.
      const revoke = URL.revokeObjectURL.bind(URL);
      window.setTimeout(() => revoke(url), 1000);
      setStatus('Download requested. If it does not start, use “Open download in new tab” below.');
    } catch {
      setError(true);
      setStatus('The download could not start inside the preview. Use “Open download in new tab” below.');
    } finally { setPending(false); }
  };

  return <div className="rounded border bg-background p-3 space-y-2">
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={download} disabled={pending}
        className="inline-flex rounded border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        data-testid="button-download-connector">
        {pending ? 'Preparing download…' : 'Download WareIQ connector'}
      </button>
      <a href={href} download={filename} target="_blank" rel="noopener noreferrer"
        className="text-xs underline" data-testid="link-download-connector">
        Open download in new tab
      </a>
    </div>
    {status && <p role={error ? 'alert' : 'status'} className={`text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{status}</p>}
    <p className="text-xs text-muted-foreground">
      Includes both connector files and installation instructions. Extract the package and
      follow README.md on your Linux VPN-connected server, or give the package to your IT administrator.
      No credentials are included. Downloading it does not install it or start OpenVPN.
    </p>
  </div>;
}
