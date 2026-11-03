import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronDown, X } from 'lucide-react';
import {
  useSla, setManualDue, revertManualDue, excuse, removeExcuse, setScenario, setDueBy, events, usage, whyThis,
  PREVIOUS, SCENARIOS, SLA_DEMO_ID, fmtDue, fmtDur, fmtTime, STATE_LABEL, STATE_TONE, type ClockId, type ClockResult, type Scenario,
} from './slaEngine';

/* SLA History — the designers' 560px slide-over (white header, #F8FAFC body, white cards).
 * One scroll, grouped by who the promise is to: customer, teams, vendor, then the SLA that was replaced.
 * Each clock card carries its facts, the rare actions (change due, excuse, why) and its history. */

interface Props { isOpen: boolean; onClose: () => void; focus: ClockId | null }
type PanelKind = 'due' | 'excuse' | 'why';
type Panel = { id: string; kind: PanelKind } | null;

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3D8BD0]/40';
const LINK = `rounded text-[12px] font-medium text-[#3D8BD0] hover:text-[#3479B8] hover:underline ${FOCUS}`;
const CARD = 'rounded-xl border border-[#EEF1F5] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]';
const PRIMARY = `rounded bg-[#3D8BD0] px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#3479B8] ${FOCUS}`;
const SECONDARY = `rounded border border-[#DFE5ED] bg-white px-3 py-1.5 text-[12px] font-medium text-[#364658] transition-colors hover:bg-[#F3F4F6] ${FOCUS}`;
const FIELD = 'w-full rounded border border-[#DFE5ED] bg-white px-2.5 py-1.5 text-[13px] text-[#364658] placeholder:text-[#9CA3AF] focus:border-[#3D8BD0] focus:outline-none focus:ring-2 focus:ring-[#3D8BD0]/20';
const GREY = { bg: '#F1F5F9', text: '#64748B', bar: '#94A3B8' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 4:10 PM": timeline and table times, always the same width. */
const short = (d: Date) => `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${fmtTime(d)}`;
const lower = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
/** datetime-local wants local "YYYY-MM-DDTHH:mm". */
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const handedOver = (r: ClockResult) => r.state === 'met' && r.def.doneVerb === 'Handed over';
const isRunning = (r: ClockResult) => !r.stop && r.state !== 'excused';

function chipOf(r: ClockResult) {
  return handedOver(r) ? { label: 'Handed over', tone: GREY } : { label: STATE_LABEL[r.state], tone: STATE_TONE[r.state] };
}
function valueOf(r: ClockResult) {
  if (r.breached) return `${fmtDur(r.stop ? r.counted - r.budget : -r.left)} over`;
  if (handedOver(r)) return `${fmtDur(r.counted)} of ${fmtDur(r.budget)}`;
  if (r.state === 'met') return `Met in ${fmtDur(r.counted)}`;
  return `${fmtDur(r.left)} left`;
}

function Chip({ label, tone }: { label: string; tone: { bg: string; text: string } }) {
  return <span className="inline-flex flex-shrink-0 items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium" style={{ backgroundColor: tone.bg, color: tone.text }}>{label}</span>;
}

export function SlaDetailsDrawer({ isOpen, onClose, focus }: Props) {
  const { scenario, clocks, previous, edge } = useSla();
  const now = scenario.now;
  const [panel, setPanel] = useState<Panel>(null);
  const [disclosed, setDisclosed] = useState<Set<string>>(new Set());
  const [currentOnly, setCurrentOnly] = useState(false);
  const [flash, setFlash] = useState<ClockId | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cards = useRef<Partial<Record<ClockId, HTMLDivElement | null>>>({});

  // open: reset, focus the close button, then scroll to (and briefly highlight) the clock the user clicked
  useEffect(() => {
    if (!isOpen) return;
    setPanel(null); setDisclosed(new Set()); setCurrentOnly(false); setFlash(focus);
    const raf = requestAnimationFrame(() => {
      dialogRef.current?.focus({ preventScroll: true });
      const body = bodyRef.current, el = focus ? cards.current[focus] : null;
      if (body) body.scrollTop = el ? el.offsetTop - 20 : 0;
    });
    const t = window.setTimeout(() => setFlash(null), 1600);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(t); };
  }, [isOpen, focus]);
  // give focus back to whatever opened the slide-over
  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, [isOpen]);

  const closePanel = () => {
    const p = panel;
    setPanel(null);
    if (p) requestAnimationFrame(() => document.getElementById(`sla-act-${p.id}-${p.kind}`)?.focus());
  };
  // Esc closes an open inline panel first, then the slide-over
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') (panel ? closePanel() : onClose()); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!isOpen) return null;

  const togglePanel = (id: string, kind: PanelKind) => setPanel(p => (p?.id === id && p.kind === kind ? null : { id, kind }));
  const toggleDisclosure = (key: string) => setDisclosed(p => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const shared = { now, scenario, panel, togglePanel, closePanel, disclosed, toggleDisclosure };

  const groups: [string, ClockResult[]][] = [
    ['Customer SLA', clocks.filter(c => c.def.kind === 'SLA')],
    ['Team targets', clocks.filter(c => c.def.kind === 'OLA')],
    ['Vendor contract', clocks.filter(c => c.def.kind === 'UC')],
  ];
  const earlier = previous.length > 0 && PREVIOUS.canceledAt <= now;
  const sub = edge === 'nosla' ? `${SLA_DEMO_ID} has no SLA. Its due time was set by hand.` : `Every SLA clock on ${SLA_DEMO_ID}, as of ${fmtDue(now, now)}`;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[10000] bg-black/30" onClick={onClose} />
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="sla-history-title" className="fixed right-0 top-0 z-[10001] flex h-full w-[560px] max-w-[94vw] flex-col bg-[#F8FAFC] outline-none shadow-2xl">
        <div className="flex-shrink-0 border-b border-[#E5E7EB] bg-white px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <h2 id="sla-history-title" className="text-[18px] font-semibold text-[#111827]">SLA History</h2>
            <button onClick={onClose} aria-label="Close" className={`flex size-8 flex-shrink-0 items-center justify-center rounded text-[#6B7280] transition-colors hover:bg-[#F3F4F6] hover:text-[#111827] ${FOCUS}`}><X size={20} /></button>
          </div>
          <p className="text-[13px] text-[#6B7280]">{sub}</p>
          {earlier && (
            <div role="group" aria-label="Show" className="mt-3 inline-flex rounded border border-[#DFE5ED] bg-[#F8FAFC] p-0.5">
              {([[false, 'All clocks'], [true, 'Current SLA only']] as const).map(([v, label]) => (
                <button key={label} aria-pressed={currentOnly === v} onClick={() => setCurrentOnly(v)}
                  className={`rounded px-3 py-1 text-[12px] font-medium transition-colors ${FOCUS} ${currentOnly === v ? 'bg-white text-[#364658] shadow-[0_1px_2px_rgba(16,24,40,0.08)]' : 'text-[#7B8FA5] hover:text-[#364658]'}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div ref={bodyRef} className="relative flex-1 space-y-6 overflow-auto px-6 py-5">
          {edge === 'error' && (
            <div className={`${CARD} px-4 py-3.5 text-[13px] text-[#4A5568]`}>
              SLA times couldn't be loaded.{' '}
              <button onClick={() => setScenario('risk')} className={LINK}>Try again</button>
            </div>
          )}
          {edge === 'nosla' && <DueByCard {...shared} />}
          {groups.map(([title, list]) => list.length > 0 && (
            <Section key={title} title={title} count={list.length}>
              {list.map(r => (
                <div key={r.def.id} ref={el => { cards.current[r.def.id] = el; }}
                  className={`rounded-xl transition-shadow duration-500 ${flash === r.def.id ? 'ring-2 ring-[#3D8BD0]/40' : ''}`}>
                  <ClockCard r={r} {...shared} />
                </div>
              ))}
            </Section>
          ))}
          {earlier && !currentOnly && (
            <Section title="Earlier SLA, canceled" count={1}><EarlierCard previous={previous} /></Section>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

interface Shared {
  now: Date; scenario: Scenario; panel: Panel; togglePanel: (id: string, k: PanelKind) => void; closePanel: () => void;
  disclosed: Set<string>; toggleDisclosure: (key: string) => void;
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[13px] font-semibold text-[#364658]">{title} <span className="font-normal text-[#7B8FA5]">({count})</span></h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[#7B8FA5]">{label}</div>
      <div className="text-[13px] text-[#364658]">{value}</div>
      {sub && <div className="whitespace-pre-line text-[12px] text-[#7B8FA5]">{sub}</div>}
    </div>
  );
}

/** Name, chip and the one number that matters, on one line. */
function Head({ name, chip, value, valueColor }: { name: string; chip: ReactNode; value: string; valueColor: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="truncate text-[14px] font-semibold text-[#111827]">{name}</span>
      {chip}
      <span className="ml-auto whitespace-nowrap pl-3 text-[16px] font-semibold tabular-nums" style={{ color: valueColor }}>{value}</span>
    </div>
  );
}

function Actions({ id, items, panel, onToggle }: { id: string; items: { kind?: PanelKind; label: string; run?: () => void }[]; panel: Panel; onToggle: (k: PanelKind) => void }) {
  return (
    <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
      {items.map(a => (
        <button key={a.label} id={a.kind ? `sla-act-${id}-${a.kind}` : undefined} className={`${LINK} aria-expanded:text-[#3479B8] aria-expanded:underline`}
          aria-expanded={a.kind ? panel?.id === id && panel.kind === a.kind : undefined}
          onClick={() => (a.kind ? onToggle(a.kind) : a.run?.())}>
          {a.label}
        </button>
      ))}
    </div>
  );
}

function ClockCard({ r, now, scenario, panel, togglePanel, closePanel, disclosed, toggleDisclosure }: { r: ClockResult } & Shared) {
  const { def } = r, id = def.id, chip = chipOf(r);
  const why = whyThis(r), evs = events(r, scenario);
  const lastEsc = evs.filter(e => e.kind === 'escalated').pop();
  const valueColor = r.state === 'ok' || r.state === 'met' ? '#111827' : chip.tone.text;
  const movedBy = !r.manual && r.due && r.pausedClosed > 0 && r.firstDue.getTime() !== r.policyDue.getTime() ? r.pausedClosed : 0;

  const due = r.state === 'paused' && !r.due ? 'Set again when the clock restarts' : r.due ? fmtDue(r.due, now) : 'Not set';
  const dueSub = r.manual ? `Set by ${r.manual.by}\nPolicy time ${fmtDue(r.policyDue, now)}` : movedBy ? `Moved ${fmtDur(movedBy)} by pauses` : undefined;
  const esc = def.escalations.length === 0 ? 'None set up'
    : lastEsc ? `Level ${r.escLevel} sent ${fmtDue(lastEsc.at, now)}` : r.stop ? 'None' : 'None yet';
  const open = (k: PanelKind) => panel?.id === id && panel.kind === k;

  const actions = [
    ...(isRunning(r) ? [{ kind: 'due' as const, label: 'Change due time' }] : []),
    ...(r.manual ? [{ label: 'Use policy time again', run: () => revertManualDue(id) }] : []),
    ...(r.breached && !r.excuse ? [{ kind: 'excuse' as const, label: 'Excuse breach' }] : []),
    ...(r.excuse ? [{ label: 'Remove excuse', run: () => removeExcuse(id) }] : []),
    { kind: 'why' as const, label: 'Why this SLA?' },
  ];
  const whatKey = `${id}:what`, whoKey = `${id}:who`;
  const team = def.name.replace(' · OLA', '');
  const holder = def.kind === 'OLA' ? usage(r, scenario).find(u => u.group === team)?.who : undefined;

  return (
    <div className={CARD}>
      <div className="px-4 pb-4 pt-3.5">
        <Head name={def.name} chip={<Chip {...chip} />} value={valueOf(r)} valueColor={valueColor} />
        <div className="mt-2.5 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#EEF1F5]">
            <div className="h-full rounded-full" style={{ width: `${Math.min(r.pct, 1) * 100}%`, backgroundColor: chip.tone.bar }} />
          </div>
          <span className="whitespace-nowrap text-[12px] tabular-nums text-[#7B8FA5]">{Math.round(r.pct * 100)} % used</span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3">
          <Fact label="Started" value={fmtDue(def.start, now)} />
          <Fact label="Due" value={due} sub={dueSub} />
          {r.stop && <Fact label={def.doneVerb} value={fmtDue(r.stop, now)} />}
          <Fact label="Paused" value={r.paused ? fmtDur(r.paused) : 'Not paused'}
            sub={r.pausedNow ? `Since ${fmtTime(r.pausedNow.from)}, ${lower(r.pausedNow.why)}` : undefined} />
          <Fact label="Runs on" value={def.hours.calendar ? '24 x 7' : def.hours.name} sub={def.hours.calendar ? 'Nights and weekends count' : def.hours.line} />
          <Fact label="Escalation" value={esc} />
          {r.penalty > 0 && <Fact label="Penalty" value={`$${r.penalty.toFixed(2)}`} sub={`$${def.penaltyPerHour} per started hour over`} />}
          {r.excuse && <Fact label="Excused" value={r.excuse.reason} sub={`By ${r.excuse.by}, ${fmtDue(r.excuse.at, now)}`} />}
          {def.kind === 'OLA' && <Fact label="Team" value={team} sub={holder} />}
          {def.kind === 'UC' && <Fact label="Vendor" value={def.rule[0][2]} />}
        </div>

        <Actions id={id} items={actions} panel={panel} onToggle={k => togglePanel(id, k)} />
        {open('due') && (
          <ChangeDue id={id} initial={r.due ?? r.policyDue} now={now} reason onCancel={closePanel}
            onSave={(d, reason) => { setManualDue(id, d, reason); closePanel(); }} />
        )}
        {open('excuse') && <ExcuseForm id={id} onCancel={closePanel} onSave={reason => { excuse(id, reason); closePanel(); }} />}
        {open('why') && (
          <InlinePanel>
            <dl className="grid grid-cols-[104px_1fr] gap-x-3 gap-y-2">
              {([['Policy', why.policy], ['Applies because', why.matched], ['Target', why.target], ['Runs on', why.hours], ['Starts', why.started]] as const).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-[12px] leading-5 text-[#7B8FA5]">{k}</dt>
                  <dd className="text-[13px] leading-5 text-[#364658]">{v}</dd>
                </div>
              ))}
            </dl>
            {r.manual && <p className="mt-3 text-[13px] text-[#364658]">Due time set by {r.manual.by}{r.manual.reason ? `: ${r.manual.reason}` : '.'}</p>}
            {scenario.edge === 'archived' && scenario.deletedOn && def.policy.startsWith('P2 High') && (
              <p className="mt-3 text-[13px] text-[#364658]">
                This SLA was deleted on {scenario.deletedOn.getDate()} {MONTHS[scenario.deletedOn.getMonth()]}. The request keeps the targets it had.
              </p>
            )}
          </InlinePanel>
        )}
      </div>

      <div className="flex gap-5 border-t border-[#F0F1F3] px-4">
        <Disclosure label={`What happened (${evs.length})`} open={disclosed.has(whatKey)} onClick={() => toggleDisclosure(whatKey)} />
        <Disclosure label="Who used the clock" open={disclosed.has(whoKey)} onClick={() => toggleDisclosure(whoKey)} />
      </div>
      {disclosed.has(whatKey) && <Timeline evs={evs} />}
      {disclosed.has(whoKey) && <Usage r={r} scenario={scenario} />}
    </div>
  );
}

function Disclosure({ label, open, onClick }: { label: string; open: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-expanded={open} className={`flex items-center gap-1 rounded py-2.5 text-[12px] font-medium text-[#4A5568] hover:text-[#111827] ${FOCUS}`}>
      {label}
      <ChevronDown size={14} className={`text-[#9CA3AF] transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  );
}

const DOT: Record<string, string> = { breached: '#E74C3C', met: '#27AE60', 'handed-over': '#27AE60', escalated: '#F39C12', overridden: '#3D8BD0' };

function Timeline({ evs }: { evs: ReturnType<typeof events> }) {
  return (
    <ol className="border-t border-[#F0F1F3] px-4 py-3">
      {evs.map((e, i) => {
        const last = i === evs.length - 1;
        return (
          <li key={i} className="flex gap-3">
            <span className="w-[92px] flex-shrink-0 whitespace-nowrap text-[12px] leading-5 tabular-nums text-[#7B8FA5]">{short(e.at)}</span>
            <span className="flex flex-col items-center" aria-hidden="true">
              <span className="mt-1.5 size-2 rounded-full" style={{ backgroundColor: DOT[e.kind] ?? '#94A3B8' }} />
              {!last && <span className="mt-1 w-px flex-1 bg-[#E5E7EB]" />}
            </span>
            <div className={`min-w-0 flex-1 ${last ? '' : 'pb-3'}`}>
              <div className="text-[13px] leading-5 text-[#364658]">{e.text}</div>
              {e.by !== 'SLA engine' && <div className="text-[12px] text-[#7B8FA5]">by {e.by}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Usage({ r, scenario }: { r: ClockResult; scenario: Scenario }) {
  const rows = usage(r, scenario);
  const th = 'pb-1.5 font-normal', td = 'py-1.5 whitespace-nowrap';
  return (
    <div className="border-t border-[#F0F1F3] px-4 py-3">
      <table className="w-full text-[12px] text-[#364658]">
        <thead>
          <tr className="text-left text-[11px] text-[#7B8FA5]">
            <th className={th}>Team</th><th className={th}>Person</th><th className={th}>From</th><th className={th}>To</th>
            <th className={`${th} pl-3 text-right`}>Counted</th><th className={`${th} pl-3 text-right`}>Paused</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((u, i) => (
            <tr key={i} className="border-t border-[#F0F1F3]">
              <td className={td}>{u.group}</td><td className={td}>{u.who}</td><td className={td}>{short(u.from)}</td><td className={td}>{u.to ? short(u.to) : 'Now'}</td>
              <td className={`${td} pl-3 text-right`}>{fmtDur(u.counted)}</td><td className={`${td} pl-3 text-right`}>{u.paused ? fmtDur(u.paused) : '0m'}</td>
            </tr>
          ))}
          {rows.length > 1 && (
            <tr className="border-t border-[#E5E7EB] font-semibold">
              <td className={td} colSpan={4}>Total</td>
              <td className={`${td} pl-3 text-right`}>{fmtDur(rows.reduce((a, u) => a + u.counted, 0))}</td>
              <td className={`${td} pl-3 text-right`}>{fmtDur(rows.reduce((a, u) => a + u.paused, 0))}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function InlinePanel({ children }: { children: ReactNode }) {
  return <div className="mt-3 rounded-lg border border-[#DFE5ED] bg-[#F8FAFC] p-3">{children}</div>;
}

function ChangeDue({ id, initial, now, reason: withReason, onSave, onCancel }: {
  id: string; initial: Date; now: Date; reason?: boolean; onSave: (d: Date, reason: string) => void; onCancel: () => void;
}) {
  const [when, setWhen] = useState(local(initial));
  const [reason, setReason] = useState('');
  const d = when ? new Date(when) : null;
  return (
    <InlinePanel>
      <label htmlFor={`due-${id}`} className="block text-[12px] text-[#4A5568]">New due time</label>
      <input id={`due-${id}`} type="datetime-local" autoFocus value={when} onChange={e => setWhen(e.target.value)} className={`mt-1 max-w-[260px] ${FIELD}`} />
      {d && d <= now && (
        <p className="mt-2 flex items-start gap-1.5 rounded bg-[#FFF3E0] px-2.5 py-1.5 text-[12px] text-[#364658]">
          <AlertTriangle size={14} className="mt-px flex-shrink-0 text-[#F39C12]" />
          This time has passed, so the clock will show as breached straight away.
        </p>
      )}
      {withReason && <>
        <label htmlFor={`due-reason-${id}`} className="mt-3 block text-[12px] text-[#4A5568]">Reason (optional)</label>
        <textarea id={`due-reason-${id}`} rows={2} value={reason} onChange={e => setReason(e.target.value)} className={`mt-1 resize-none ${FIELD}`} />
      </>}
      <div className="mt-3 flex gap-2">
        <button disabled={!d} onClick={() => d && onSave(d, reason.trim())} className={`${PRIMARY} disabled:opacity-50`}>Save due time</button>
        <button onClick={onCancel} className={SECONDARY}>Cancel</button>
      </div>
    </InlinePanel>
  );
}

function ExcuseForm({ id, onSave, onCancel }: { id: string; onSave: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState(false);
  return (
    <InlinePanel>
      <label htmlFor={`excuse-${id}`} className="block text-[12px] text-[#4A5568]">Reason</label>
      <textarea id={`excuse-${id}`} rows={2} autoFocus value={reason} aria-invalid={error} aria-describedby={`excuse-help-${id}`}
        onChange={e => { setReason(e.target.value); setError(false); }}
        className={`mt-1 resize-none ${FIELD} ${error ? '!border-[#E74C3C]' : ''}`} />
      {error && <p className="mt-1 text-[12px] text-[#E74C3C]">Add a reason so reports show why this was excused.</p>}
      <p id={`excuse-help-${id}`} className="mt-2 text-[12px] text-[#7B8FA5]">Only managers can excuse a breach. Reports still count it, marked Excused.</p>
      <div className="mt-3 flex gap-2">
        <button onClick={() => (reason.trim() ? onSave(reason.trim()) : setError(true))} className={PRIMARY}>Excuse breach</button>
        <button onClick={onCancel} className={SECONDARY}>Cancel</button>
      </div>
    </InlinePanel>
  );
}

/* No SLA: one hand-set Due By, which can be moved and moved back. */
function DueByCard({ now, scenario, panel, togglePanel, closePanel }: Shared) {
  const due = scenario.dueBy!, original = SCENARIOS.nosla.dueBy!;
  const left = Math.round((due.getTime() - now.getTime()) / 60000), over = left <= 0;
  const tone = over ? STATE_TONE.breached : STATE_TONE.ok;
  const actions = [
    { kind: 'due' as const, label: 'Change due time' },
    ...(due.getTime() !== original.getTime() ? [{ label: 'Use original time again', run: () => setDueBy(original) }] : []),
  ];
  return (
    <div className={`${CARD} px-4 pb-4 pt-3.5`}>
      <Head name="Due By, set by hand" chip={<Chip label={over ? 'Breached' : 'On track'} tone={tone} />}
        value={over ? `${fmtDur(-left)} over` : `${fmtDur(left)} left`} valueColor={over ? tone.text : '#111827'} />
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3">
        <Fact label="Due" value={fmtDue(due, now)} />
        <Fact label="Set by" value="Sarah Johnson" />
      </div>
      <Actions id="dueby" items={actions} panel={panel} onToggle={k => togglePanel('dueby', k)} />
      {panel?.id === 'dueby' && <ChangeDue id="dueby" initial={due} now={now} onCancel={closePanel} onSave={d => { setDueBy(d); closePanel(); }} />}
    </div>
  );
}

/* The SLA the priority change replaced. Built from PREVIOUS only: events() can't describe a canceled clock. */
function EarlierCard({ previous }: { previous: ClockResult[] }) {
  return (
    <div className={CARD}>
      <div className="px-4 pb-3 pt-3.5">
        <div className="text-[14px] font-semibold text-[#111827]">{PREVIOUS.policy}, canceled {short(PREVIOUS.canceledAt)}</div>
        <p className="mt-1 text-pretty text-[13px] text-[#4A5568]">
          {PREVIOUS.change} by {PREVIOUS.by}. The new SLA counts from when the request was created, so time already spent carries over.
        </p>
      </div>
      {previous.map(r => {
        // only a clock that finished before the cancel keeps its result; the rest were cut off by it
        const canceled = !r.stop || r.def.doneVerb === 'Canceled';
        return (
          <div key={r.def.id} className="flex items-center gap-2 border-t border-[#F0F1F3] px-4 py-2.5">
            <span className="text-[13px] font-medium text-[#364658]">{r.def.name}</span>
            {canceled ? <Chip label="Canceled" tone={GREY} /> : <Chip label={STATE_LABEL[r.state]} tone={STATE_TONE[r.state]} />}
            <span className="ml-auto text-[13px] tabular-nums text-[#364658]">
              {canceled ? `${fmtDur(r.counted)} counted when canceled` : r.breached ? `${fmtDur(r.counted - r.budget)} over` : `Met in ${fmtDur(r.counted)}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
