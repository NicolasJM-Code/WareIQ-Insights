import type { CaptureReadiness } from '@workspace/api-client-react';

export function CaptureReadinessNotice({ readiness }: { readiness: CaptureReadiness }) {
  return <div className="space-y-2 rounded-md border p-3 text-[12px]" data-testid="capture-readiness">
    <h3 className="font-semibold">External role capture · {readiness.environment ?? 'environment not configured'}</h3>
    {readiness.configuration === 'not_configured' ? <>
      <p role="alert">External role capture is not configured. External changes may be missing from this history.</p>
      <p>Signing configuration: {readiness.signing === 'configured' ? 'configured' : 'missing or invalid'}.
        {' '}Routing configuration: {readiness.routing === 'configured' ? 'configured' : 'missing or invalid'}.
        {' '}Clerk key mode: {readiness.keyMode === 'configured' ? 'matches routing' : 'missing or mismatched'}.</p>
      <p>Owner action: configure the matching environment, pinned instance and signing secret, then test a signed user.updated delivery. See docs/access-change-history.md.</p>
    </> : <>
      <p>Local capture configuration is present. This does not verify the provider subscription or public routing.</p>
      {readiness.delivery === 'delivery_problem'
        ? <p role="alert">Delivery problem: a signed, matching-instance role observation or its completion diagnostic could not be saved. Check application database availability and retry the delivery.</p>
        : readiness.delivery === 'delivery_unknown'
          ? <p role="alert">Delivery outcome unknown: a signed, matching-instance role delivery started but its completion was not recorded. A server interruption or database outage may have occurred. Check storage and retry the delivery.</p>
        : readiness.delivery === 'diagnostics_unavailable'
          ? <p role="alert">Delivery diagnostics unavailable. Current delivery status is unknown; check application database availability. Historical observations do not establish current subscription health.</p>
        : readiness.delivery === 'verified_delivery'
          ? <p>A signed, matching-instance role observation was saved. This is historical delivery evidence, not proof the subscription is currently healthy.</p>
          : <p>Delivery health unknown: no persisted signed role observation is available for this environment and instance. Test a user.updated delivery; an absence of recent role events does not mean the subscription failed.</p>}
    </>}
    {readiness.lastVerifiedDeliveryAt && <p>Last persisted signed role observation: <time dateTime={readiness.lastVerifiedDeliveryAt}>{new Date(readiness.lastVerifiedDeliveryAt).toLocaleString()}</time> (server receipt time).</p>}
    {readiness.lastDeliveryFailureAt && <p>Last verified delivery storage failure: <time dateTime={readiness.lastDeliveryFailureAt}>{new Date(readiness.lastDeliveryFailureAt).toLocaleString()}</time>.</p>}
    <p className="text-muted-foreground">Delivery diagnostics are shared across servers and retained across restarts for this environment and Clerk instance. Provider-side delivery failures remain unknown. No event-age threshold is used.</p>
  </div>;
}
