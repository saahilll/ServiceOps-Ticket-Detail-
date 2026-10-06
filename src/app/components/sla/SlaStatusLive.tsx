import { useState } from 'react';
import { SlaDetailsDrawer } from './SlaDetailsDrawer';
import { useSla, setScenario, SCENARIOS, fmtDur, fmtTime, finishedLine, type ClockId, type ClockResult, type ClockState, type ScenarioKey } from './slaEngine';

/* SLA Status card body — the same rows as the Key Information card (120px label, value with a status dot,
 * a plain sub-line). Customer SLAs always show; team and vendor clocks show only while running or breached
 * (met ones live in the drawer). Status is said in words; the dot repeats it in color. */

const plainName = (r: ClockResult) => r.def.name.replace(/^(OLA|UC) · /, '');
const DOT: Record<ClockState, string> = { ok: '#27AE60', met: '#27AE60', risk: '#F39C12', paused: '#9AA8C0', breached: '#E74C3C', missed: '#E74C3C' };
/** "3:10 PM" when it's today, "Wed 3:10 PM" when it isn't. */
const dueAt = (d: Date, now: Date) => (d.toDateString() === now.toDateString() ? '' : d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ') + fmtTime(d);

function value(r: ClockResult) {
  switch (r.state) {
    case 'ok': case 'risk': return `${fmtDur(r.left)} left`;
    case 'paused': return `Paused, ${fmtDur(r.left)} left`;
    case 'met': return 'Met';
    case 'breached': case 'missed': return 'Breached';
  }
}
function subLine(r: ClockResult, now: Date) {
  if (r.state === 'met') return finishedLine(r);
  if (r.state === 'missed') return finishedLine(r);  // e.g. "Replied 5:15 PM, 35m late"
  if (r.state === 'breached') return `${fmtDur(-r.left)} over, was due ${dueAt(r.due!, now)}`;
  if (r.state === 'paused') return `Waiting since ${fmtTime(r.pausedNow!.from)}`;
  const due = `Due ${dueAt((r.manual?.due ?? r.due)!, now)}`;
  if (r.manual) return `${due}, set by hand`;
  const moved = r.due && r.pausedClosed && r.firstDue.getTime() !== r.policyDue.getTime();
  return `${due}${moved ? `, moved ${fmtDur(r.pausedClosed)}` : ''}`;
}

function Row({ label, r, now, onOpen }: { label: string; r: ClockResult; now: Date; onOpen: () => void }) {
  const bad = r.state === 'breached' || r.state === 'missed';
  return (
    <button onClick={onOpen} className="-mx-2 w-[calc(100%+16px)] flex items-start gap-3 rounded-md px-2 py-1.5 text-left hover:bg-[#F3F4F6]">
      <span className="w-[120px] flex-shrink-0 pt-px text-[12px] text-[#4A5568]">{label}</span>
      <span className="min-w-0 flex-1">
        <span className={`flex items-center gap-1.5 text-[13px] font-medium ${bad ? 'text-[#E74C3C]' : 'text-[#364658]'}`}>
          <span className="size-2 flex-shrink-0 rounded-full" style={{ backgroundColor: DOT[r.state] }} />
          <span className="tabular-nums">{value(r)}{r.state === 'risk' && <span className="font-normal text-[#B7791F]">, at risk</span>}</span>
        </span>
        <span className="block pl-3.5 text-[12px] text-[#7B8FA5]">{subLine(r, now)}</span>
      </span>
    </button>
  );
}

export function SlaStatusLive() {
  const { clocks, scenario } = useSla();
  const [open, setOpen] = useState<ClockId | null>(null);
  const customer = clocks.filter(c => c.def.kind === 'SLA');
  const others = clocks.filter(c => c.def.kind !== 'SLA' && (!c.stop || c.state === 'missed'));  // running or breached only
  const penalty = clocks.reduce((a, c) => a + c.penalty, 0);

  return (
    <div className="px-4 pb-4">
      {customer.map(r => <Row key={r.def.id} label={r.def.short} r={r} now={scenario.now} onOpen={() => setOpen(r.def.id)} />)}
      {others.length > 0 && <div className="mt-2 mb-0.5 text-[11px] font-medium text-[#9CA3AF]">Team and vendor</div>}
      {others.map(r => <Row key={r.def.id} label={plainName(r)} r={r} now={scenario.now} onOpen={() => setOpen(r.def.id)} />)}
      {penalty > 0 && (
        <div className="flex items-start gap-3 py-1.5">
          <span className="w-[120px] flex-shrink-0 text-[12px] text-[#4A5568]">Penalty</span>
          <span className="text-[13px] font-medium text-[#E74C3C] tabular-nums">${penalty.toFixed(2)}</span>
        </div>
      )}
      <SlaDetailsDrawer isOpen={!!open} onClose={() => setOpen(null)} focus={open ?? 'resolution'} />
    </div>
  );
}

/** The customer SLA's name, once, in the card header: "P2 High", or "P2 High (was P3 Standard)" after a change.
 *  Response and Resolution share the policy, so one name covers both. */
export function SlaPolicyName() {
  const { clocks, scenario } = useSla();
  const res = clocks.find(c => c.def.id === 'resolution');
  if (!res) return null;
  const short = (p: string) => p.replace(/ – .*$/, '');
  const was = res.def.replaced && res.def.replaced.at <= scenario.now ? res.def.replaced.policy : null;
  return (
    <span className="text-[12px] text-[#7B8FA5] truncate" title={res.def.policy}>
      · {short(res.def.policy)}{was && <span className="text-[#9CA3AF]"> (was {short(was)})</span>}
    </span>
  );
}

/** Prototype-only scenario switch. Lives OUTSIDE the product UI (bottom-left corner of the screen). */
export function SlaDemoSwitch() {
  const { scenario } = useSla();
  return (
    <div className="fixed top-1 left-1/2 -translate-x-1/2 z-[9000] flex items-center gap-2 rounded-full bg-[#111827] px-3 py-1.5 text-[11px] text-white/70 ">
      <span>Prototype</span>
      <select aria-label="SLA demo scenario" value={scenario.key} onChange={e => setScenario(e.target.value as ScenarioKey)}
        className="bg-transparent text-[11px] font-medium text-white outline-none">
        {(Object.keys(SCENARIOS) as ScenarioKey[]).map(k => <option key={k} value={k} className="text-[#111827]">{SCENARIOS[k].label}</option>)}
      </select>
    </div>
  );
}

/** Header alert pill for the Request page, from the same engine — so header and card agree. */
export function useSlaHeaderAlert() {
  const { clocks } = useSla();
  const res = clocks.find(c => c.def.id === 'resolution')!;
  // any customer SLA breached (running past due, or finished late) turns the header red, right away
  const hit = clocks.filter(c => c.def.kind === 'SLA' && (c.state === 'breached' || c.state === 'missed'));
  if (hit.length) {
    const running = hit.find(c => c.state === 'breached');
    return { key: 'sla', label: running ? 'SLA Overdue' : 'SLA Breached', tone: 'danger', icon: 'breach',
      tip: hit.map(c => `${c.def.name} SLA: breached by ${fmtDur(c.counted - c.def.target)}`).join(' · ') } as const;
  }
  const tone = res.state === 'risk' ? 'warning' : res.state === 'met' ? 'success' : 'info';
  const label = { ok: 'SLA Due', risk: 'SLA At Risk', paused: 'SLA Paused', breached: 'SLA Overdue', met: 'SLA Met', missed: 'SLA Breached' }[res.state];
  const icon = tone === 'success' ? 'check' : res.state === 'paused' ? 'waiting' : 'clock';
  return { key: 'sla', label, tone, icon, tip: `Resolution SLA: ${value(res)}` } as const;
}
