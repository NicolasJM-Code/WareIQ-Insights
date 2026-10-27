import { useMemo } from 'react';
import { PageHeader, Kpi, KpiGrid, Panel, BarList, DataReport, DetailList, Pill, Meter } from '@/components/report-kit';
import { SHIFTS, ROLE_TARGETS, type Role, type WhCode } from '@/lib/data';
import { useScoped, useDocTitle } from '@/lib/report-context';
import { num, dec, pct } from '@/lib/format';

interface OpRow { operator: string; role: Role; wh: WhCode; shifts: number; hours: number; tasks: number; lines: number; units: number; idle: number; rate: number; vsTarget: number }

export default function Labour() {
  useDocTitle('Labour & productivity');
  const shifts = useScoped(SHIFTS);
  const ops = useMemo<OpRow[]>(() => {
    const m = new Map<string, OpRow>();
    for (const s of shifts) {
      const r = m.get(s.operator) ?? { operator: s.operator, role: s.role, wh: s.wh, shifts: 0, hours: 0, tasks: 0, lines: 0, units: 0, idle: 0, rate: 0, vsTarget: 0 };
      r.shifts++; r.hours += s.hours; r.tasks += s.tasks; r.lines += s.lines; r.units += s.units; r.idle += s.idleMin;
      m.set(s.operator, r);
    }
    return [...m.values()].map((r) => { const rate = r.lines / r.hours; return { ...r, rate, vsTarget: (rate / ROLE_TARGETS[r.role]) * 100 }; });
  }, [shifts]);
  const hours = ops.reduce((a, o) => a + o.hours, 0);
  const idle = ops.reduce((a, o) => a + o.idle, 0);
  const atTarget = ops.filter((o) => o.vsTarget >= 100).length;
  const roles = (Object.keys(ROLE_TARGETS) as Role[]).map((role) => {
    const rs = ops.filter((o) => o.role === role);
    const h = rs.reduce((a, o) => a + o.hours, 0);
    return { role, rate: h ? rs.reduce((a, o) => a + o.lines, 0) / h : 0, target: ROLE_TARGETS[role], people: rs.length };
  });

  return (
    <div>
      <PageHeader eyebrow="10 · People" title="Labour & productivity" description="Workload and throughput per operator against role targets. Rates are lines per productive hour." />
      <KpiGrid>
        <Kpi label="Operators active" value={num(ops.length)} sub={`${num(shifts.length)} shifts`} tone="info" />
        <Kpi label="Hours worked" value={num(hours)} tone="neutral" />
        <Kpi label="Lines processed" value={num(ops.reduce((a, o) => a + o.lines, 0))} sub={`${num(ops.reduce((a, o) => a + o.units, 0))} units`} tone="info" />
        <Kpi label="Idle time" value={pct(hours ? (idle / 60 / hours) * 100 : NaN)} sub={`${num(idle / 60)}h recorded`} tone="warn" />
        <Kpi label="At or above target" value={`${atTarget}/${ops.length}`} tone={atTarget >= ops.length / 2 ? 'good' : 'warn'} />
      </KpiGrid>
      <div className="grid gap-4 lg:grid-cols-2 mb-4">
        <Panel title="Rate vs target by role" meta="lines / hour">
          <ul className="space-y-3">
            {roles.map((r) => (
              <li key={r.role} className="text-[12.5px]">
                <div className="flex justify-between mb-1"><span>{r.role} <span className="text-muted-foreground">· {r.people} people</span></span><span className="font-mono tnum">{dec(r.rate)} / {r.target}</span></div>
                <Meter value={r.target ? (r.rate / r.target) * 100 : 0} tone={r.rate >= r.target ? 'good' : 'warn'} />
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Lines by operator" meta="top 8"><BarList items={[...ops].sort((a, b) => b.lines - a.lines).slice(0, 8).map((o) => ({ label: o.operator, value: o.lines, hint: o.role }))} format={num} tone="bg-chart-3" /></Panel>
      </div>
      <DataReport<OpRow>
        title="Operator productivity" filename="wareiq-labour-productivity" rows={ops} rowKey={(r) => r.operator}
        searchText={(r) => `${r.operator} ${r.role} ${r.wh}`}
        facets={[{ key: 'role', label: 'Role', value: (r) => r.role }, { key: 'wh', label: 'Site', value: (r) => r.wh }, { key: 'perf', label: 'Performance', value: (r) => (r.vsTarget >= 100 ? 'At target' : 'Below target') }]}
        columns={[
          { key: 'op', label: 'Operator', value: (r) => r.operator },
          { key: 'role', label: 'Role', value: (r) => r.role },
          { key: 'wh', label: 'Site', value: (r) => r.wh },
          { key: 'shifts', label: 'Shifts', value: (r) => r.shifts, align: 'right' },
          { key: 'hours', label: 'Hours', value: (r) => r.hours, align: 'right', render: (r) => dec(r.hours) },
          { key: 'tasks', label: 'Tasks', value: (r) => r.tasks, align: 'right', render: (r) => num(r.tasks) },
          { key: 'lines', label: 'Lines', value: (r) => r.lines, align: 'right', render: (r) => num(r.lines) },
          { key: 'units', label: 'Units', value: (r) => r.units, align: 'right', render: (r) => num(r.units) },
          { key: 'rate', label: 'Lines/h', value: (r) => Math.round(r.rate * 10) / 10, align: 'right', render: (r) => dec(r.rate) },
          { key: 'vs', label: 'vs target', value: (r) => Math.round(r.vsTarget), render: (r) => <Pill tone={r.vsTarget >= 100 ? 'good' : r.vsTarget >= 85 ? 'warn' : 'bad'}>{Math.round(r.vsTarget)}%</Pill> },
        ]}
        detail={(r) => ({ title: r.operator, subtitle: `${r.role} · ${r.wh}`, body: <DetailList items={[['Shifts', r.shifts], ['Hours', dec(r.hours)], ['Tasks', num(r.tasks)], ['Lines', num(r.lines)], ['Units', num(r.units)], ['Avg task duration', `${dec((r.hours * 60) / Math.max(1, r.tasks), 2)} min`], ['Idle recorded', `${num(r.idle)} min`], ['Rate', `${dec(r.rate)} lines/h`], ['Role target', `${ROLE_TARGETS[r.role]} lines/h`]]} /> })}
      />
    </div>
  );
}
