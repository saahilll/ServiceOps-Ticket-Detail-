import { Fragment, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, ChevronRight, Clock } from 'lucide-react';
import { SlaDetailsDrawer } from './SlaDetailsDrawer';
import { DueByPill } from '../TicketTable';
import type { HeaderAlert } from '../HeaderAlertPills';
import {
  useSla, ME, setScenario, setCardStyle, setPanelStyle, SCENARIOS, headerSummary, handedOver, fmtDur, fmtTime, fmtDue, shortValue, overBy, lower, policyShort, archivedNote, LOAD_ERROR, PILL_TONE, STATE_LABEL, KIND_COLOUR,
  type ClockId, type ClockResult, type ScenarioKey, type CardStyle, type PanelStyle,
} from './slaEngine';

/* Service Levels card for the demo request, in the designers' card style (INC-31): label left, hourglass pill
 * right, a muted sub-line under it. Clocks are grouped by kind (SLA, OLA, UC), each group marked by one shade of
 * blue (a rail or a tint, prototype switch), never green / amber / red, which belong to the clock states.
 * Every clock keeps its row; a finished one goes quiet (no pill) so the eye lands on the live ones. */

type Kind = ClockResult['def']['kind'];
/** "Network Team · OLA" → "Network Team": inside its group the kind is already said. */
const shortName = (r: ClockResult) => r.def.name.replace(/ · (OLA|UC)$/, '');

/** ["At risk", "due today 4:20 PM IST", "set by Sarah Johnson"]: shown joined by commas,
 *  each part kept whole so a wrap breaks between parts, never inside one. */
function subLine(r: ClockResult, now: Date) {
  if (r.state === 'paused') return [`Paused since ${fmtTime(r.pausedNow!.from)}`, `status ${r.pausedNow!.status}`];
  if (r.state === 'excused') return [`Excused by ${r.excuse!.by}`];
  if (handedOver(r)) return [`To ${r.def.stopWhy.replace(/^request moved to /, '')}`, fmtDue(r.stop!, now)];
  if (r.stop) return [`${r.def.doneVerb} ${fmtDue(r.stop, now)}`, ...(r.breached ? [`${overBy(r)} late`] : [])];
  return [STATE_LABEL[r.state], `${r.state === 'breached' ? 'was due' : 'due'} ${fmtDue(r.due!, now)}`, ...(r.manual ? [`set by ${r.manual.by}`] : [])];
}

/** Right side of a row: the live pill, or a quiet outcome once the clock has stopped. */
function Outcome({ r }: { r: ClockResult }) {
  if (!r.stop && r.state !== 'excused') return <DueByPill tone={PILL_TONE[r.state]} label={shortValue(r)} className="flex-shrink-0" />;
  const [Icon, cls, text] = r.breached ? [AlertCircle, 'text-[#E74C3C]', `${overBy(r)} over`]
    : r.state === 'excused' ? [null, 'text-[#64748B]', 'Excused']
    : handedOver(r) ? [null, 'text-[#64748B]', 'Handed over']
    : [CheckCircle2, 'text-[#27AE60]', `Met in ${fmtDur(r.counted)}`];
  return (
    <span className={`flex flex-shrink-0 items-center gap-1 whitespace-nowrap text-[12px] font-medium ${cls}`}>
      {Icon && <Icon size={12} />}{text}
    </span>
  );
}

/** One sentence for a finished clock, for the header pill's tooltip. */
function finished(r: ClockResult) {
  if (r.state === 'excused') return `${r.def.name} excused`;
  if (r.breached) return `${r.def.name} breached, ${lower(r.def.doneVerb)} ${overBy(r)} late`;
  return `${r.def.name} met in ${fmtDur(r.counted)}`;
}

const ROW = 'group -mx-2 flex w-[calc(100%+16px)] flex-col gap-0.5 rounded px-2 py-1.5 text-left';
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3D8BD0]/40';

/** `penalty`: this clock's own penalty, shown in red under the pill so the money sits under the time it's for. */
function Row({ label, right, sub, quiet, penalty, onOpen }: { label: string; right: ReactNode; sub: string[]; quiet?: boolean; penalty?: number; onOpen?: () => void }) {
  const body = (
    <>
      <span className="flex w-full items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1">
          <span className={`truncate text-[12px] font-medium ${quiet ? 'text-[#64748B]' : 'text-[#364658]'}`}>{label}</span>
          {onOpen && <ChevronRight size={12} aria-hidden="true" className="flex-shrink-0 text-[#7B8FA5] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />}
        </span>
        {right}
      </span>
      <span className="flex w-full items-start justify-between gap-3">
        <span className="text-[12px] text-[#7B8FA5]">
          {sub.map((p, i) => <Fragment key={i}>{i > 0 && ' '}<span className="whitespace-nowrap">{p}{i < sub.length - 1 && ','}</span></Fragment>)}
        </span>
        {!!penalty && <span className="flex-shrink-0 text-[12px] font-semibold tabular-nums text-[#E74C3C]" aria-label={`Penalty $${penalty.toFixed(2)}`}>${penalty.toFixed(2)}</span>}
      </span>
    </>
  );
  return onOpen
    ? <button onClick={onOpen} className={`${ROW} ${FOCUS} cursor-pointer transition-colors hover:bg-black/[0.03]`}>{body}</button>
    : <div className={ROW}>{body}</div>;
}

/** One kind's clocks: a blue rail down the left, or a faint blue block. */
function Group({ kind, style, children }: { kind: Kind; style: CardStyle; children: ReactNode }) {
  const c = KIND_COLOUR[kind];
  return (
    <section aria-label={kind}
      className={style === 'rail' ? 'border-l-2 pl-3' : 'rounded-lg px-3 py-1.5'}
      style={style === 'rail' ? { borderColor: c.line } : { backgroundColor: c.tint }}>
      <h4 className="pt-0.5 text-[11px] font-semibold" style={{ color: c.text }}>{kind}</h4>
      {children}
    </section>
  );
}

const LIMIT = 6;

export function SlaStatusLive() {
  const { clocks, scenario, edge, cardStyle } = useSla();
  const [focus, setFocus] = useState<ClockId | null>(null);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const now = scenario.now;
  const show = (id: ClockId | null) => { setFocus(id); setOpen(true); };

  if (edge === 'error') {
    return (
      <div className="px-4 pb-4 text-[12px] text-[#4A5568]">
        {LOAD_ERROR}{' '}
        <button onClick={() => setScenario('risk')} className={`rounded text-[12px] font-medium text-[#3D8BD0] hover:text-[#3479B8] hover:underline ${FOCUS}`}>Try again</button>
      </div>
    );
  }
  if (edge === 'nosla') {
    const due = scenario.dueBy!, left = (due.getTime() - now.getTime()) / 60000, over = left <= 0;
    return (
      <div className="px-4 pb-4">
        <Row label="Due By" right={<DueByPill tone={over ? 'breached' : 'ok'} label={`${fmtDur(left)} ${over ? 'over' : 'left'}`} />}
          sub={[`${over ? 'Breached, was due' : 'Due'} ${fmtDue(due, now)}`, `set by ${ME}`]} onOpen={() => show(null)} />
        <SlaDetailsDrawer isOpen={open} onClose={() => setOpen(false)} focus={null} />
      </div>
    );
  }

  // "Show all" counts rows across the groups; the cut keeps whole rows, never an empty group
  const shown = all ? clocks : clocks.slice(0, LIMIT);
  const groups = (['SLA', 'OLA', 'UC'] as const).map(k => [k, shown.filter(c => c.def.kind === k)] as const).filter(([, l]) => l.length);

  return (
    <div className="px-4 pb-4">
      {edge === 'archived' && scenario.deletedOn && (
        <p className="mb-1 text-[12px] text-[#7B8FA5]">
          {archivedNote(scenario.deletedOn)[0]}{' '}
          <span className="whitespace-nowrap">{archivedNote(scenario.deletedOn)[1]}</span>
        </p>
      )}
      <div className={cardStyle === 'rail' ? 'space-y-3' : 'space-y-2'}>
        {groups.map(([kind, list]) => (
          <Group key={kind} kind={kind} style={cardStyle}>
            {list.map(r => (
              <Row key={r.def.id} label={shortName(r)} sub={subLine(r, now)} quiet={!!r.stop || r.state === 'excused'}
                right={<Outcome r={r} />} penalty={r.penalty} onOpen={() => show(r.def.id)} />
            ))}
          </Group>
        ))}
      </div>
      {clocks.length > LIMIT && !all && (
        <button onClick={() => setAll(true)} className={`mt-1 rounded text-[12px] font-medium text-[#3D8BD0] hover:text-[#3479B8] hover:underline ${FOCUS}`}>Show all {clocks.length}</button>
      )}
      <button onClick={() => show(null)}
        className={`mt-3 flex w-full items-center justify-center gap-2 rounded border border-[#DFE5ED] bg-white px-3 py-1.5 text-[12px] font-medium text-[#3D8BD0] transition-colors hover:bg-[#EBF5FF] ${FOCUS}`}>
        <Clock size={14} />
        Service Level History
      </button>
      <SlaDetailsDrawer isOpen={open} onClose={() => setOpen(false)} focus={focus} />
    </div>
  );
}

/** Total penalty, after "Service Levels": red once any clock owes one, muted at $0.00 so it is always findable.
 *  Shown only when some clock carries a penalty rule. Each clock's own share is on its row. */
export function SlaPenaltyTotal() {
  const { clocks, edge } = useSla();
  if (edge === 'nosla' || edge === 'error' || !clocks.some(c => c.def.penaltyPerHour)) return null;
  const total = clocks.reduce((a, c) => a + c.penalty, 0);
  return (
    <span className={`ml-auto mr-1 rounded px-1.5 py-0.5 text-[12px] tabular-nums ${total > 0 ? 'bg-[#FFEBEE] font-semibold text-[#E74C3C]' : 'text-[#7B8FA5]'}`}>
      Penalty ${total.toFixed(2)}
    </span>
  );
}

/** Prototype-only scenario switch, kept out of the product UI: a small chip bottom-left, sitting just above
 *  the reply bar (bottom-3 would cover its avatar and "Reply with AI" at 1440x900). */
export function SlaDemoSwitch() {
  const { scenario, cardStyle, panelStyle } = useSla();
  return (
    <label className="fixed bottom-[80px] left-[62px] z-[9000] flex items-center gap-1.5 rounded bg-[#111827]/90 px-2 py-1 text-[11px] text-white/70 shadow-md">
      Demo:
      <select value={scenario.key} aria-label="Demo scenario" onChange={e => setScenario(e.target.value as ScenarioKey)}
        className="w-[124px] bg-transparent text-[11px] font-medium text-white outline-none">
        {(Object.keys(SCENARIOS) as ScenarioKey[]).map(k => <option key={k} value={k} className="text-[#111827]">{SCENARIOS[k].label}</option>)}
      </select>
      <span className="ml-1">Card:</span>
      <select value={cardStyle} onChange={e => setCardStyle(e.target.value as CardStyle)} aria-label="Card style"
        className="bg-transparent text-[11px] font-medium text-white outline-none">
        <option value="rail" className="text-[#111827]">Rail</option>
        <option value="tint" className="text-[#111827]">Tint</option>
      </select>
      <span className="ml-1">Panel:</span>
      <select value={panelStyle} onChange={e => setPanelStyle(e.target.value as PanelStyle)} aria-label="Panel style"
        className="bg-transparent text-[11px] font-medium text-white outline-none">
        {([['A', 'A · Cards'], ['B', 'B · List'], ['C', 'C · Focus'], ['D', 'D · Steps']] as const).map(([v, l]) => <option key={v} value={v} className="text-[#111827]">{l}</option>)}
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
  const tail = `, ${policyShort(r.def.policy)}`;
  switch (r.state) {
    case 'ok': case 'risk':
      return { key: 'sla', label: `${name} ${shortValue(r)}`, tone: r.state === 'risk' ? 'warning' : 'info', icon: 'clock', tip: `${r.def.name}, due ${fmtDue(r.due!, scenario.now)}${tail}` };
    case 'breached':
      return { key: 'sla', label: `${name} breached`, tone: 'danger', icon: 'breach', tip: `${r.def.name}, was due ${fmtDue(r.due!, scenario.now)}${tail}` };
    case 'paused':
      return { key: 'sla', label: 'SLA paused', tone: 'neutral', icon: 'pause', tip: `${r.def.name}, ${subLine(r, scenario.now).join(', ')}${tail}` };
    case 'missed':
      return { key: 'sla', label: `${name} breached`, tone: 'danger', icon: 'breach', tip: `${finished(r)}${tail}` };
    case 'excused':
      return { key: 'sla', label: 'SLA excused', tone: 'neutral', icon: 'check', tip: `${finished(r)}${tail}` };
    case 'met':
      return { key: 'sla', label: 'SLA met', tone: 'success', icon: 'check', tip: `${finished(r)}${tail}` };
  }
}
