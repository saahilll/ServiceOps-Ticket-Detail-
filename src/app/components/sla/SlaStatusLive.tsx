import { Fragment, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, MinusCircle, ChevronRight, Clock } from 'lucide-react';
import { SlaDetailsDrawer } from './SlaDetailsDrawer';
import { DueByPill } from '../TicketTable';
import type { HeaderAlert } from '../HeaderAlertPills';
import { useSla, ME, setScenario, SCENARIOS, headerSummary, fmtDur, fmtTime, fmtDue, shortValue, STATE_LABEL, type ClockId, type ClockResult, type ScenarioKey } from './slaEngine';

/* SLA Status card body for the demo request, in the designers' card style (INC-31): label left,
 * hourglass pill right, a muted sub-line under it. Running clocks first, finished ones below as
 * one quiet line each, then Penalty and the SLA History button. */

const PILL_TONE = { ok: 'ok', risk: 'due', paused: 'paused', breached: 'breached' } as const;
const lower = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
const policyShort = (r: ClockResult) => r.def.policy.replace(/ – .*$/, '');

/** ["At risk", "due today 4:20 PM IST", "set by Sarah Johnson", "level 1 escalation sent"]: shown joined by commas,
 *  each part kept whole so a wrap breaks between parts, never inside one. */
function subLine(r: ClockResult, now: Date) {
  if (r.state === 'paused') return [`Paused since ${fmtTime(r.pausedNow!.from)}`, lower(r.pausedNow!.why)];
  return [
    STATE_LABEL[r.state], `${r.state === 'breached' ? 'was due' : 'due'} ${fmtDue(r.due!, now)}`,
    ...(r.manual ? [`set by ${r.manual.by}`] : []), ...(r.escLevel ? [`level ${r.escLevel} escalation sent`] : []),
  ];
}

/** One quiet line for a clock that has stopped (or was excused). */
function finished(r: ClockResult, now: Date): { text: string; tone: 'met' | 'bad' | 'muted' } {
  if (r.state === 'excused') return { text: `${r.def.name} excused`, tone: 'muted' };
  if (r.breached) return { text: `${r.def.name} breached, ${lower(r.def.doneVerb)} ${fmtDur(r.counted - r.budget)} late`, tone: 'bad' };
  if (r.def.doneVerb === 'Handed over') return { text: `${r.def.name} handed over ${r.stop!.toDateString() === now.toDateString() ? '' : `${r.stop!.toLocaleDateString('en-US', { weekday: 'short' })} `}at ${fmtTime(r.stop!)}`, tone: 'met' };
  return { text: `${r.def.name} met in ${fmtDur(r.counted)}`, tone: 'met' };
}
const FIN_ICON = { met: [CheckCircle2, 'text-[#27AE60]', 'text-[#4A5568]'], bad: [AlertCircle, 'text-[#E74C3C]', 'text-[#E74C3C]'], muted: [MinusCircle, 'text-[#64748B]', 'text-[#64748B]'] } as const;

const ROW = 'group -mx-2 flex w-[calc(100%+16px)] flex-col gap-0.5 rounded px-2 py-1.5 text-left';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3D8BD0]/40';

function Row({ label, pill, sub, onOpen }: { label: string; pill: ReactNode; sub: string[]; onOpen?: () => void }) {
  const body = (
    <>
      <span className="flex w-full items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-[12px] font-medium text-[#364658]">{label}</span>
          {onOpen && <ChevronRight size={12} className="flex-shrink-0 text-[#7B8FA5] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />}
        </span>
        {pill}
      </span>
      <span className="text-[12px] text-[#7B8FA5]">
        {sub.map((p, i) => <Fragment key={i}>{i > 0 && ' '}<span className="whitespace-nowrap">{p}{i < sub.length - 1 && ','}</span></Fragment>)}
      </span>
    </>
  );
  return onOpen
    ? <button onClick={onOpen} className={`${ROW} ${FOCUS} cursor-pointer transition-colors hover:bg-[#F3F4F6]`}>{body}</button>
    : <div className={ROW}>{body}</div>;
}

const LIMIT = 6;

export function SlaStatusLive() {
  const { clocks, scenario, edge } = useSla();
  const [focus, setFocus] = useState<ClockId | null>(null);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const now = scenario.now;
  const show = (id: ClockId | null) => { setFocus(id); setOpen(true); };

  if (edge === 'error') {
    return (
      <div className="px-4 pb-4 text-[12px] text-[#4A5568]">
        SLA times couldn't be loaded.{' '}
        <button onClick={() => setScenario('risk')} className={`rounded text-[12px] font-medium text-[#3D8BD0] hover:text-[#3479B8] hover:underline ${FOCUS}`}>Try again</button>
      </div>
    );
  }
  if (edge === 'nosla') {
    const due = scenario.dueBy!, left = (due.getTime() - now.getTime()) / 60000, over = left <= 0;
    return (
      <div className="px-4 pb-4">
        <Row label="Due By" pill={<DueByPill tone={over ? 'breached' : 'ok'} label={`${fmtDur(left)} ${over ? 'over' : 'left'}`} />}
          sub={[`${over ? 'Breached, was due' : 'Due'} ${fmtDue(due, now)}`, `set by ${ME}`]} onOpen={() => show(null)} />
        <SlaDetailsDrawer isOpen={open} onClose={() => setOpen(false)} focus={null} />
      </div>
    );
  }

  const running = clocks.filter(c => !c.stop && c.state !== 'excused');
  const done = clocks.filter(c => c.stop || c.state === 'excused');
  const penalty = clocks.reduce((a, c) => a + c.penalty, 0);
  const items = [
    ...running.map(r => (
      <Row key={r.def.id} label={r.def.name} sub={subLine(r, now)} onOpen={() => show(r.def.id)}
        pill={<DueByPill tone={PILL_TONE[r.state as keyof typeof PILL_TONE]} label={shortValue(r)} className="flex-shrink-0" />} />
    )),
    ...done.map(r => {
      const f = finished(r, now), [Icon, iconCls, textCls] = FIN_ICON[f.tone];
      return (
        <button key={r.def.id} onClick={() => show(r.def.id)} className={`${ROW} ${FOCUS} !flex-row items-center gap-1.5 transition-colors hover:bg-[#F3F4F6]`}>
          <Icon size={12} className={`flex-shrink-0 ${iconCls}`} />
          <span className={`text-[12px] ${textCls}`}>{f.text}</span>
        </button>
      );
    }),
  ];
  const shown = all ? items : items.slice(0, LIMIT);

  return (
    <div className="px-4 pb-4">
      {edge === 'archived' && scenario.deletedOn && (
        <p className="mb-1 text-[12px] text-[#7B8FA5]">
          This SLA was deleted on {scenario.deletedOn.getDate()} {scenario.deletedOn.toLocaleDateString('en-US', { month: 'short' })}.{' '}
          <span className="whitespace-nowrap">The request keeps its targets.</span>
        </p>
      )}
      {shown}
      {items.length > LIMIT && !all && (
        <button onClick={() => setAll(true)} className={`mt-1 rounded text-[12px] font-medium text-[#3D8BD0] hover:text-[#3479B8] hover:underline ${FOCUS}`}>Show all {items.length}</button>
      )}
      {penalty > 0 && (
        <div className="mt-1 flex items-center justify-between gap-3 py-1.5">
          <span className="text-[12px] font-medium text-[#364658]">Penalty</span>
          <span className="flex-shrink-0 rounded bg-[#FFEBEE] px-2 py-0.5 text-[12px] font-semibold tabular-nums text-[#E74C3C]">${penalty.toFixed(2)}</span>
        </div>
      )}
      <button onClick={() => show(null)}
        className={`mt-2 flex w-full items-center justify-center gap-2 rounded border border-[#DFE5ED] bg-white px-3 py-1.5 text-[12px] font-medium text-[#3D8BD0] transition-colors hover:bg-[#EBF5FF] ${FOCUS}`}>
        <Clock size={14} />
        SLA History
      </button>
      <SlaDetailsDrawer isOpen={open} onClose={() => setOpen(false)} focus={focus} />
    </div>
  );
}

/** The policy name, muted, after "SLA Status": "P2 High", "P2 High (was P3 Standard)", "P2 High (deleted)", "No SLA". */
export function SlaPolicyName() {
  const { clocks, scenario, edge } = useSla();
  if (edge === 'nosla') return <span className="truncate text-[12px] text-[#7B8FA5]">No SLA</span>;
  const res = clocks.find(c => c.def.id === 'resolution');
  if (!res) return null;
  const was = res.def.replaced && res.def.replaced.at <= scenario.now ? res.def.replaced.policy.replace(/ – .*$/, '') : null;
  const note = edge === 'archived' ? 'deleted' : was ? `was ${was}` : null;
  return (
    <span className="truncate text-[12px] text-[#7B8FA5]">
      {policyShort(res)}{note && ` (${note})`}
    </span>
  );
}

/** Prototype-only scenario switch, kept out of the product UI: a small chip bottom-left, sitting just above
 *  the reply bar (bottom-3 would cover its avatar and "Reply with AI" at 1440x900). */
export function SlaDemoSwitch() {
  const { scenario } = useSla();
  return (
    <label className="fixed bottom-[80px] left-[62px] z-[9000] flex items-center gap-1.5 rounded bg-[#111827]/90 px-2 py-1 text-[11px] text-white/70 shadow-md">
      Demo:
      <select value={scenario.key} onChange={e => setScenario(e.target.value as ScenarioKey)}
        className="w-[124px] bg-transparent text-[11px] font-medium text-white outline-none">
        {(Object.keys(SCENARIOS) as ScenarioKey[]).map(k => <option key={k} value={k} className="text-[#111827]">{SCENARIOS[k].label}</option>)}
      </select>
    </label>
  );
}

/** The header's one SLA pill, from the same engine as the card, so the two always agree. */
export function useSlaHeaderAlert(): HeaderAlert | null {
  const { clocks, scenario, edge } = useSla();
  if (edge === 'error') return null;
  if (edge === 'nosla') {
    const at = fmtDue(scenario.dueBy!, scenario.now);
    if (scenario.dueBy! <= scenario.now) return { key: 'sla', label: 'Due By breached', tone: 'danger', icon: 'breach', tip: `Was due ${at}, set by ${ME}` };
    return { key: 'sla', label: `Due ${at}`, tone: 'info', icon: 'clock', tip: `Due ${at}, set by ${ME}` };
  }
  const { clock: r } = headerSummary(clocks);
  if (!r) return null;
  const name = r.def.name.replace(' · ', ' ');
  const tail = `, ${policyShort(r)}`;
  switch (r.state) {
    case 'ok': case 'risk':
      return { key: 'sla', label: `${name} ${shortValue(r)}`, tone: r.state === 'risk' ? 'warning' : 'info', icon: 'clock', tip: `${r.def.name}, due ${fmtDue(r.due!, scenario.now)}${tail}` };
    case 'breached':
      return { key: 'sla', label: `${name} breached`, tone: 'danger', icon: 'breach', tip: `${r.def.name}, was due ${fmtDue(r.due!, scenario.now)}${tail}` };
    case 'paused':
      return { key: 'sla', label: 'SLA paused', tone: 'neutral', icon: 'waiting', tip: `${r.def.name}, ${lower(subLine(r, scenario.now).join(', '))}${tail}` };
    case 'missed':
      return { key: 'sla', label: 'SLA breached', tone: 'danger', icon: 'breach', tip: `${finished(r, scenario.now).text}${tail}` };
    case 'excused':
      return { key: 'sla', label: 'SLA excused', tone: 'neutral', icon: 'check', tip: `${finished(r, scenario.now).text}${tail}` };
    case 'met':
      return { key: 'sla', label: 'SLA met', tone: 'success', icon: 'check', tip: `${finished(r, scenario.now).text}${tail}` };
  }
}
