import type { WmsNetworkConfig, WmsNetworkResult } from '@workspace/api-client-react';

export function WmsVpnSteps({ config, unavailable, pending, ready, result, onCheck }: {
  config?: WmsNetworkConfig;
  unavailable: boolean;
  pending: boolean;
  ready: boolean;
  result: WmsNetworkResult | null;
  onCheck: () => void;
}) {
  return <section className="rounded-md border bg-muted/30 p-4 space-y-3" aria-label="VPN then SQL connection">
    <div className="text-sm font-semibold">Connection path: OpenVPN → MySQL</div>
    <p className="text-xs text-muted-foreground">
      Run the secure connector on your existing Linux OpenVPN-connected server.
      WareIQ checks its VPN interface, database route and TCP reachability before attempting a verified-TLS SQL login.
    </p>
    <div className="rounded border bg-background p-3 space-y-2">
      <a href={`${import.meta.env.BASE_URL}downloads/wareiq-openvpn-connector.zip`}
        download="wareiq-openvpn-connector.zip"
        className="inline-flex rounded border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        data-testid="link-download-connector">Download WareIQ connector</a>
      <p className="text-xs text-muted-foreground">
        Includes both connector files and installation instructions. Extract the package and
        follow README.md on your Linux VPN-connected server, or give the package to your IT administrator.
        No credentials are included. Downloading it does not install it or start OpenVPN.
      </p>
    </div>
    {unavailable ? <p role="alert" className="text-xs text-destructive">Connection-path configuration could not be loaded. MySQL testing is locked until it can be verified.</p>
      : <p className="text-xs">{config?.message ?? 'Loading server connection path…'}</p>}
    {config?.path === 'openvpn' && <div role="status" className="text-xs space-y-1" data-testid="status-vpn-monitor">
      <p><strong>Background monitoring: </strong>{
        unavailable || !config.monitoring || config.monitoring.status === 'unknown'
          ? 'Unknown — monitoring cannot currently verify connectivity.'
          : config.monitoring.status === 'healthy'
            ? 'VPN route and database TCP port reachable. SQL login is not verified.'
            : config.monitoring.status === 'unavailable'
              ? 'Unavailable — connector or warehouse route check failed.'
              : 'Disabled.'
      }</p>
      {!unavailable && config.monitoring?.checkedAt && <p>Last check: {new Date(config.monitoring.checkedAt).toLocaleString()}</p>}
      <p>Checks run once a minute while the API is running. Verified administrators receive an email after two consecutive failures and a recovery email when reachability returns.</p>
    </div>}
    {config?.path === 'direct' && <p className="text-xs text-muted-foreground">
      VPN mode is not active. An owner must configure <code>WMS_OPENVPN_CONNECTOR_URL</code> and
      its secret token, then set <code>WMS_MYSQL_CONNECTION_PATH=openvpn</code> on the server.
      Until then, the existing direct path remains active.
    </p>}
    <div className="grid sm:grid-cols-2 gap-3 text-xs">
      <div className="rounded border bg-background p-3 space-y-2">
        <h3 className="font-semibold">1. Check OpenVPN connection</h3>
        <p>{ready ? 'VPN route verified for these fields. Ready to test SQL.' : 'No current VPN route verification for these connection fields.'}</p>
        <button type="button" onClick={onCheck}
          disabled={pending || unavailable || !config?.configured || config.path !== 'openvpn'}
          className="rounded border px-3 py-2 disabled:opacity-50" data-testid="button-test-vpn">
          {pending ? 'Checking VPN…' : 'Check VPN connection'}
        </button>
      </div>
      <div className="rounded border bg-background p-3 space-y-2">
        <h3 className="font-semibold">2. Test SQL connection</h3>
        <p>{config?.path === 'openvpn'
          ? 'Use the SQL test below after VPN readiness succeeds. Readiness expires after one minute. The API checks the VPN again for every SQL test and live report; it never falls back to direct access.'
          : 'The existing direct SQL path is still active. VPN-first gating starts only when an owner enables the OpenVPN path on the server.'}</p>
      </div>
    </div>
    {result && <p role="status" className="text-xs" data-testid="status-vpn-result">
      <strong>{result.code}</strong> · {result.message}
    </p>}
    <p className="text-xs text-muted-foreground">
      The connector does not start or manage OpenVPN. The VPN must already be running on that server.
      Never upload VPN profiles, passwords or private keys into this form. Setup: <code>docs/openvpn-connector.md</code>.
    </p>
  </section>;
}
