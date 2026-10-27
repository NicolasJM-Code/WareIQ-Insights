import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Database, PlugZap, Copy, ShieldCheck, Lock, Server, Info, RotateCcw, Save, Users, KeyRound, CalendarClock, ScrollText, Bell, CircleSlash } from 'lucide-react';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader, Pill } from '@/components/report-kit';
import { useReport, useDocTitle, type Prefs, type RefreshInterval, type RangeDays } from '@/lib/report-context';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useTestWmsConnection, type WmsConnectionResult } from '@workspace/api-client-react';
import { useUser, UserButton } from '@clerk/react';
import { Link } from 'wouter';
import { AccessManagement } from '@/components/access-management';
import { AccessHistory } from '@/components/access-history';

const hostRe = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$|^(\d{1,3}\.){3}\d{1,3}$/;
const ident = /^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/;

const connSchema = z.object({
  host: z.string().trim().min(1, 'Host is required').regex(hostRe, 'Enter a valid hostname or IPv4 address'),
  port: z.coerce.number({ invalid_type_error: 'Port must be a number' }).int('Whole number').min(1, '1–65535').max(65535, '1–65535'),
  database: z.string().trim().min(1, 'Database name is required').regex(ident, 'Letters, digits and underscores; must not start with a digit'),
  schema: z.string().trim().min(1, 'Schema is required').regex(ident, 'Letters, digits and underscores; must not start with a digit'),
  username: z.string().trim().min(1, 'Reporting username is required').regex(ident, 'Use a valid PostgreSQL role name'),
  sslMode: z.literal('verify-full'),
  refreshInterval: z.enum(['1', '5', '15', '30', 'manual']),
  queryTimeoutSec: z.coerce.number({ invalid_type_error: 'Timeout must be a number' }).int('Whole seconds').min(5, 'Minimum 5 seconds').max(300, 'Maximum 300 seconds'),
});
type Conn = z.infer<typeof connSchema>;

interface LogEntry { at: string; host: string; outcome: string }
interface LogEntry { at: string; host: string; outcome: string }
interface LogEntry { at: string; host: string; outcome: string }
interface LogEntry { at: string; host: string; outcome: string }

function Section({ icon: Icon, title, children, aside }: { icon: typeof Database; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rise rounded-md border bg-card">
      <header className="flex items-center gap-2.5 px-5 py-3.5 border-b">
        <Icon className="h-4 w-4 text-primary" />
        <h2 className="text-[14px] font-semibold">{title}</h2>
        {aside && <div className="ml-auto">{aside}</div>}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

const Unavailable = () => <Pill tone="neutral">Unavailable until live setup</Pill>;

export default function Settings() {
  useDocTitle('Settings');
  const { prefs, setPrefs, resetPrefs } = useReport();
  const { user, isSignedIn } = useUser();
  const testConnection = useTestWmsConnection();
  const [requestError, setRequestError] = useState<string | null>(null);
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<WmsConnectionResult | 'invalid' | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  useEffect(() => {
    setTestResult(null);
    setRequestError(null);
    setLastSuccessfulAt(null);
    setLog([]);
  }, [user?.id]);

  const form = useForm<Conn>({
    resolver: zodResolver(connSchema),
    defaultValues: { host: '', port: 5432, database: '', schema: 'public', username: '', sslMode: 'verify-full', refreshInterval: prefs.refreshInterval, queryTimeoutSec: prefs.queryTimeoutSec },
    mode: 'onTouched',
  });
  useEffect(() => {
    const subscription = form.watch(() => {
      setTestResult(null);
      setRequestError(null);
    });
    return () => subscription.unsubscribe();
  }, [form]);

  const onTest = async () => {
    if (testConnection.isPending) return;
    setRequestError(null);
    const ok = await form.trigger();
    if (!ok) {
      setTestResult('invalid');
      return;
    }
    setTestResult(null);
    const { refreshInterval: _refreshInterval, ...input } = form.getValues();
    try {
      const result = await testConnection.mutateAsync({ data: input });
      setTestResult(result);
      if (result.lastSuccessfulAt) setLastSuccessfulAt(result.lastSuccessfulAt);
      setLog((l) => [{ at: result.testedAt, host: `${input.host}:${input.port}`, outcome: `${result.code}: ${result.message}` }, ...l].slice(0, 20));
    } catch (error) {
      // Display only messages defined by this API, never an arbitrary proxy/driver body.
      const status = (error as { status?: number }).status;
      const message = status === 401 ? 'Sign in before testing the database connection.'
        : status === 403 ? 'Your account needs administrator access to test database connections.'
        : status === 429 ? 'Please wait a few seconds before testing again.'
        : 'The reporting service could not complete the test. Check your connection or try again shortly.';
      setRequestError(message);
      setLog((l) => [{ at: new Date().toISOString(), host: `${input.host}:${input.port}`, outcome: message }, ...l].slice(0, 20));
    }
  };

  const savePrefs = form.handleSubmit(
    (v) => {
      setPrefs({ ...prefs, refreshInterval: v.refreshInterval as RefreshInterval, queryTimeoutSec: v.queryTimeoutSec });
      toast({ title: 'Report preferences saved', description: 'Refresh interval and query timeout stored in this browser. Connection fields and credentials were not stored.' });
    },
    () => toast({ title: 'Fix highlighted fields', description: 'Preferences are saved together with a valid connection definition.', variant: 'destructive' }),
  );

  const copyConfig = async () => {
    const v = form.getValues();
    const cfg = { host: v.host, port: Number(v.port), database: v.database, schema: v.schema, sslmode: v.sslMode, refreshInterval: v.refreshInterval === 'manual' ? 'manual' : `${v.refreshInterval}m`, queryTimeoutSeconds: Number(v.queryTimeoutSec) };
    try {
      await navigator.clipboard.writeText(JSON.stringify(cfg, null, 2));
      toast({ title: 'Configuration copied', description: 'Non-secret fields only. Username and password are excluded.' });
    } catch {
      toast({ title: 'Clipboard unavailable', description: 'Your browser blocked clipboard access.', variant: 'destructive' });
    }
  };

  const [targets, setTargets] = useState({ targetPickAccuracy: String(prefs.targetPickAccuracy), targetFillRate: String(prefs.targetFillRate), targetDockToStockMin: String(prefs.targetDockToStockMin), defaultRange: String(prefs.defaultRange) });
  const targetErr = {
    targetPickAccuracy: !(Number(targets.targetPickAccuracy) >= 50 && Number(targets.targetPickAccuracy) <= 100) ? '50–100' : null,
    targetFillRate: !(Number(targets.targetFillRate) >= 50 && Number(targets.targetFillRate) <= 100) ? '50–100' : null,
    targetDockToStockMin: !(Number.isInteger(Number(targets.targetDockToStockMin)) && Number(targets.targetDockToStockMin) >= 10 && Number(targets.targetDockToStockMin) <= 1440) ? '10–1440 whole minutes' : null,
  };
  const saveTargets = () => {
    if (Object.values(targetErr).some(Boolean)) return;
    const next: Prefs = { ...prefs, targetPickAccuracy: Number(targets.targetPickAccuracy), targetFillRate: Number(targets.targetFillRate), targetDockToStockMin: Number(targets.targetDockToStockMin), defaultRange: Number(targets.defaultRange) as RangeDays };
    setPrefs(next);
    toast({ title: 'KPI targets saved', description: 'Dashboard and module targets now use these values.' });
  };

  return (
    <div>
      <PageHeader eyebrow="12 · Administration" title="Settings" description="Test the WMS PostgreSQL connection through the reporting server. Reports still use labeled sample data until approved reporting views are mapped." />
      <div className="mb-4 flex items-center gap-3 text-sm">
        {isSignedIn ? <><UserButton /><span>Signed in. Database tests require an administrator account.</span></> : <Link href="/sign-in" className="text-primary underline">Sign in to test the database connection</Link>}
      </div>

      <div className="rise mb-5 grid md:grid-cols-[auto_1fr_auto] items-center gap-4 rounded-md border bg-card px-5 py-4" data-testid="status-connection">
        <div className="flex items-center gap-3">
          <div className="relative h-10 w-10 rounded-md bg-muted grid place-items-center"><Database className="h-5 w-5 text-muted-foreground" /><CircleSlash className="h-3.5 w-3.5 absolute -right-1 -bottom-1 text-muted-foreground bg-card rounded-full" /></div>
          <div>
            <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">Connection status</div>
            <div className="font-display text-lg font-bold">{testConnection.isPending ? 'Testing connection…' : requestError ? 'Test could not complete' : testResult && testResult !== 'invalid' ? testResult.status === 'connected' ? 'Connection test passed' : 'Connection test failed' : 'Not tested'}</div>
          </div>
        </div>
        <dl className="grid sm:grid-cols-3 gap-3 text-[12.5px]">
          <div><dt className="text-[10px] font-mono uppercase text-muted-foreground">Last successful test this session</dt><dd data-testid="text-last-success">{lastSuccessfulAt ? new Date(lastSuccessfulAt).toLocaleString() : 'No successful test this session'}</dd></div>
          <div><dt className="text-[10px] font-mono uppercase text-muted-foreground">Data source</dt><dd>Generated sample data in the browser</dd></div>
          <div><dt className="text-[10px] font-mono uppercase text-muted-foreground">Access mode</dt><dd>Read-only reporting (SELECT only)</dd></div>
        </dl>
        <Pill tone="warn">Sample data</Pill>
      </div>

      <Tabs defaultValue="connection">
        <TabsList className="mb-4 flex-wrap h-auto">
          <TabsTrigger value="connection" data-testid="tab-connection">Database connection</TabsTrigger>
          <TabsTrigger value="reporting" data-testid="tab-reporting">KPI targets</TabsTrigger>
          <TabsTrigger value="admin" data-testid="tab-admin">Users & administration</TabsTrigger>
          <TabsTrigger value="logs" data-testid="tab-logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="connection" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
            <Section icon={Server} title="PostgreSQL connection definition">
              <Form {...form}>
                <form onSubmit={(e) => { e.preventDefault(); void savePrefs(); }} className="space-y-5" autoComplete="off" noValidate>
                  <fieldset disabled={testConnection.isPending} className="space-y-5">
                  <div className="grid sm:grid-cols-[1fr_140px] gap-4">
                    <FormField control={form.control} name="host" render={({ field }) => (
                      <FormItem><FormLabel>Database host / server address</FormLabel><FormControl><Input placeholder="wms-db.internal.example" className="font-mono" data-testid="input-host" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="port" render={({ field }) => (
                      <FormItem><FormLabel>Port</FormLabel><FormControl><Input inputMode="numeric" className="font-mono" data-testid="input-port" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <FormField control={form.control} name="database" render={({ field }) => (
                      <FormItem><FormLabel>Database name</FormLabel><FormControl><Input placeholder="wms_prod" className="font-mono" data-testid="input-database" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="schema" render={({ field }) => (
                      <FormItem><FormLabel>Database schema</FormLabel><FormControl><Input className="font-mono" data-testid="input-schema" {...field} /></FormControl><FormDescription>Schema containing WMS tables and views.</FormDescription><FormMessage /></FormItem>
                    )} />
                  </div>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <FormField control={form.control} name="username" render={({ field }) => (
                      <FormItem><FormLabel>Reporting username</FormLabel><FormControl><Input placeholder="wms_reporting_ro" className="font-mono" autoComplete="off" data-testid="input-username" {...field} /></FormControl><FormDescription>Dedicated read-only role.</FormDescription><FormMessage /></FormItem>
                    )} />
                    <div className="space-y-2">
                      <div className="text-sm font-medium flex items-center gap-1.5">Server-side password <Lock className="h-3 w-3 text-muted-foreground" /></div>
                      <p className="text-[0.8rem] text-muted-foreground">An owner must configure the credentials and approve this exact host, port, database and username on the server. Use a matching <code>WMS_DATABASE_URL</code>, or <code>WMS_PGPASSWORD</code> with all four <code>WMS_APPROVED_*</code> settings listed below. The password is never entered or stored in this browser.</p>
                    </div>
                  </div>

                  <FormField control={form.control} name="sslMode" render={({ field }) => (
                    <FormItem>
                      <FormLabel>SSL connection mode</FormLabel>
                      <FormControl>
                        <RadioGroup value={field.value} onValueChange={field.onChange} className="grid sm:grid-cols-3 gap-2">
                          {[
                            { v: 'verify-full', l: 'Verify certificate', d: 'Required: encrypted; verifies CA and hostname' },
                          ].map((o) => (
                            <label key={o.v} className={cn('flex gap-2.5 rounded-md border p-3 cursor-pointer transition-colors', field.value === o.v ? 'border-primary bg-primary/5' : 'hover:border-primary/40')}>
                              <RadioGroupItem value={o.v} className="mt-0.5" data-testid={`radio-ssl-${o.v}`} />
                              <span><span className="block text-[13px] font-medium">{o.l}</span><span className="block text-[11.5px] text-muted-foreground">{o.d}</span></span>
                            </label>
                          ))}
                        </RadioGroup>
                      </FormControl>
                      <p className="text-[12px] text-muted-foreground">For a private certificate authority, configure <code>WMS_CA_CERT</code> in server Secrets. Certificate verification cannot be disabled.</p>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <div className="grid sm:grid-cols-2 gap-4">
                    <FormField control={form.control} name="refreshInterval" render={({ field }) => (
                      <FormItem><FormLabel>Reporting refresh interval</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl><SelectTrigger data-testid="select-refresh-interval"><SelectValue /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="1">Every 1 minute</SelectItem><SelectItem value="5">Every 5 minutes</SelectItem><SelectItem value="15">Every 15 minutes</SelectItem><SelectItem value="30">Every 30 minutes</SelectItem><SelectItem value="manual">Manual refresh only</SelectItem>
                          </SelectContent>
                        </Select><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="queryTimeoutSec" render={({ field }) => (
                      <FormItem><FormLabel>Query timeout (seconds)</FormLabel><FormControl><Input inputMode="numeric" className="font-mono" data-testid="input-timeout" {...field} /></FormControl><FormDescription>5–300. Protects the live WMS from long reports.</FormDescription><FormMessage /></FormItem>
                    )} />
                  </div>

                  {testResult && testResult !== 'invalid' && (
                    <div role="status" className="rounded-md border border-[hsl(42_70%_70%)] bg-[hsl(42_90%_94%)] p-4 text-[13px] text-[hsl(30_70%_22%)]" data-testid="status-test-result">
                      <div className="font-semibold flex items-center gap-2"><Info className="h-4 w-4" />{testResult.status === 'connected' ? 'Connection test passed' : 'Connection test failed'} · {testResult.code}</div>
                      <p className="mt-1">{testResult.message}</p>
                      <p className="mt-1 text-xs">Tested {new Date(testResult.testedAt).toLocaleString()}. This test does not save a connection or switch reports to live data.</p>
                    </div>
                  )}
                  {testResult === 'invalid' && (
                    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[13px] text-destructive">Fix the highlighted fields before testing.</div>
                  )}
                  {requestError && <div role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{requestError}</div>}

                  <div className="flex flex-wrap gap-2 pt-1">
                    <button type="button" onClick={onTest} disabled={!isSignedIn || testConnection.isPending} className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-[13px] font-medium inline-flex items-center gap-2 hover:opacity-90 active:scale-[.98] transition disabled:opacity-50" data-testid="button-test-connection"><PlugZap className="h-4 w-4" /> {testConnection.isPending ? 'Testing…' : 'Test connection'}</button>
                    <button type="button" onClick={copyConfig} className="h-9 px-4 rounded-md border bg-background text-[13px] font-medium inline-flex items-center gap-2 hover:border-primary/50 transition" data-testid="button-copy-config"><Copy className="h-4 w-4" /> Copy configuration</button>
                    <button type="submit" className="h-9 px-4 rounded-md border bg-background text-[13px] font-medium inline-flex items-center gap-2 hover:border-primary/50 transition" data-testid="button-save-prefs"><Save className="h-4 w-4" /> Save report preferences</button>
                  </div>
                  <p className="text-[11.5px] text-muted-foreground">Copy configuration excludes username and password. Save stores only refresh interval and query timeout in this browser.</p>
                  </fieldset>
                </form>
              </Form>
            </Section>

            <div className="space-y-4">
              <Section icon={ShieldCheck} title="What live setup requires">
                <ol className="space-y-3 text-[12.5px]">
                  <li><span className="font-semibold">1. Server-side connection testing is available.</span> The test uses verified TLS and a bounded pool, checks role permissions and schema access, and closes the connection. It reads metadata only.</li>
                  <li><span className="font-semibold">2. Secrets held server-side.</span> Store credentials in environment variables or a secrets manager, not in browser code or source control:
                    <pre className="mt-1.5 rounded bg-muted p-2.5 font-mono text-[11px] leading-relaxed overflow-x-auto">WMS_DATABASE_URL (approved PostgreSQL URL){'\n'}or WMS_PGPASSWORD with all of:{'\n'}WMS_APPROVED_HOST{'\n'}WMS_APPROVED_PORT{'\n'}WMS_APPROVED_DATABASE{'\n'}WMS_APPROVED_USERNAME{'\n'}WMS_CA_CERT (private CA only)</pre>
                  </li>
                  <li><span className="font-semibold">3. A least-privilege role.</span> SELECT only on approved reporting tables and views.</li>
                  <li><span className="font-semibold">4. Protect the live WMS.</span> Connection pooling, statement timeouts and suitable indexes; a read replica if reporting load grows.</li>
                  <li><span className="font-semibold">5. Safe errors.</span> Users see actionable, sanitized messages. Passwords, connection strings and raw SQL errors are never logged.</li>
                </ol>
              </Section>
              <Section icon={Database} title="Example read-only role">
                <pre className="rounded bg-muted p-2.5 font-mono text-[11px] leading-relaxed overflow-x-auto whitespace-pre">{`CREATE ROLE wms_reporting_ro LOGIN;
GRANT CONNECT ON DATABASE wms_prod
  TO wms_reporting_ro;
GRANT USAGE ON SCHEMA wms
  TO wms_reporting_ro;
GRANT SELECT ON wms.v_stock_on_hand,
  wms.v_receipts, wms.v_orders
  TO wms_reporting_ro;
ALTER ROLE wms_reporting_ro
  SET statement_timeout = '30s';`}</pre>
                <p className="text-[11.5px] text-muted-foreground mt-2">Illustrative only. Object names depend on the real WMS schema, which is not available to this demo.</p>
              </Section>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="reporting">
          <Section icon={KeyRound} title="KPI targets & report defaults" aside={<button onClick={() => { resetPrefs(); setTargets({ targetPickAccuracy: '99.2', targetFillRate: '97.5', targetDockToStockMin: '120', defaultRange: '30' }); form.setValue('refreshInterval', '15'); form.setValue('queryTimeoutSec', 30); toast({ title: 'Preferences reset to defaults' }); }} className="text-[12px] inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" data-testid="button-reset-prefs"><RotateCcw className="h-3.5 w-3.5" /> Reset</button>}>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-4xl">
              {([['targetPickAccuracy', 'Pick accuracy target (%)'], ['targetFillRate', 'Fill rate target (%)'], ['targetDockToStockMin', 'Dock-to-stock target (min)']] as const).map(([k, l]) => (
                <div key={k} className="space-y-1.5">
                  <label htmlFor={k} className="text-sm font-medium">{l}</label>
                  <Input id={k} inputMode="decimal" className="font-mono" value={targets[k]} onChange={(e) => setTargets((t) => ({ ...t, [k]: e.target.value }))} aria-invalid={!!targetErr[k]} data-testid={`input-${k}`} />
                  {targetErr[k] && <p className="text-[12px] text-destructive">Must be {targetErr[k]}</p>}
                </div>
              ))}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Default date range</label>
                <Select value={targets.defaultRange} onValueChange={(v) => setTargets((t) => ({ ...t, defaultRange: v }))}>
                  <SelectTrigger data-testid="select-default-range"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="1">Last 24 hours</SelectItem><SelectItem value="7">Last 7 days</SelectItem><SelectItem value="30">Last 30 days</SelectItem><SelectItem value="90">Last 90 days</SelectItem></SelectContent>
                </Select>
              </div>
            </div>
            <button onClick={saveTargets} disabled={Object.values(targetErr).some(Boolean)} className="mt-5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-[13px] font-medium inline-flex items-center gap-2 disabled:opacity-50" data-testid="button-save-targets"><Save className="h-4 w-4" /> Save targets</button>
            <p className="text-[11.5px] text-muted-foreground mt-2">Non-sensitive preferences, stored in this browser only.</p>
          </Section>
        </TabsContent>

        <TabsContent value="admin" className="grid gap-4 lg:grid-cols-2">
          <AccessManagement />
          <Section icon={Users} title="User roles" aside={<Pill tone="good">Server enforced</Pill>}>
            <p className="text-[12.5px] text-muted-foreground mb-3">Managed sign-in verifies identity. The API checks the current, server-owned account role for every request. New accounts have no access until the application owner assigns a role.</p>
            <table className="w-full text-[12.5px]"><tbody className="divide-y">
              {[['Platform administrator', 'Client, role and user access management plus settings'], ['Client reporting role', 'Selected reports and optional own-report development, for assigned warehouses'], ['Unassigned', 'No reporting access until approved for a client and role']].map(([r, d]) => <tr key={r}><td className="py-2 font-medium pr-4">{r}</td><td className="text-muted-foreground">{d}</td></tr>)}
            </tbody></table>
          </Section>
          <Section icon={KeyRound} title="Access permissions">
            <p className="text-[12.5px] text-muted-foreground">Manage clients, reporting roles, approved login emails and assigned warehouses in <Link href="/user-access" className="underline text-primary">User access</Link>. Permissions are checked on the server. Set up a client first, then its warehouses (stored in WareIQ only, no WMS data is changed), then roles and users. Users see only warehouses explicitly assigned to them; without one they stay pending and cannot run reports. Schedules, alerts, and live reporting remain unavailable.</p>
          </Section>
          <Section icon={CalendarClock} title="Report scheduling" aside={<Unavailable />}>
            <p className="text-[12.5px] text-muted-foreground">Scheduled delivery (for example, a 06:00 daily dashboard summary to site managers) needs a server-side scheduler and mail service. Use the CSV buttons on each report for ad-hoc exports in the meantime.</p>
          </Section>
          <Section icon={Bell} title="Exception alerts" aside={<Unavailable />}>
            <p className="text-[12.5px] text-muted-foreground">Configurable thresholds (missed cut-offs, near-expiry windows, overdue tasks) would be evaluated by the reporting service. The Exceptions report shows the categories that alerts would cover.</p>
          </Section>
        </TabsContent>

        <TabsContent value="logs" className="grid gap-4 lg:grid-cols-2">
          <Section icon={ScrollText} title="Connection error log" aside={<Pill tone="neutral">This session only</Pill>}>
            {log.length ? (
              <ul className="divide-y text-[12px]" data-testid="list-error-log">
                {log.map((e) => <li key={e.at} className="py-2"><div className="font-mono text-muted-foreground">{new Date(e.at).toLocaleString('en-GB')} · {e.host}</div><div>{e.outcome}</div></li>)}
              </ul>
            ) : <p className="text-[12.5px] text-muted-foreground">No connection attempts recorded. Test attempts on the connection tab are listed here without credentials.</p>}
          </Section>
          <AccessHistory />
        </TabsContent>
      </Tabs>
    </div>
  );
}
