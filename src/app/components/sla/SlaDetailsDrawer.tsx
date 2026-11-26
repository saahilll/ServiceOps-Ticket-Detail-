import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronDown, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import {
  useSla, setScenario, setDueBy, events, usage, whyThis, headerSummary, clockChip, clockValue, timeline, canceledClocks,
  archivedNote, LOAD_ERROR, ME, SCENARIOS, fmtDue, fmtDur, fmtTime, STATE_TONE, KIND_COLOUR, type ClockId, type ClockResult, type Scenario, type Canceled, type SegKind,
} from './slaEngine';

/* Service Level History — the designers' 560px slide-over (white header, #F8FAFC body, white cards).
 * A filter picks the kind of promise (SLA first, then OLA, UC, All). Each clock card folds open to the time bar,
 * two number tiles (plus penalty once one has built up), the rules as small tags, the actions and its history.
 * Clocks a change replaced fold into one "canceled" line under the list. */

interface Props { isOpen: boolean; onClose: () => void; focus: ClockId | null }
type Kind = ClockResult['def']['kind'];
type Filter = Kind | 'All';
type PanelKind = 'due' | 'excuse' | 'why';
type Panel = { id: string; kind: PanelKind } | null;

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3D8BD0]/40';
const LINK = `rounded text-[12px] font-medium text-[#3D8BD0] hover:text-[#3479B8] hover:underline ${FOCUS}`;
const PRIMARY = `rounded bg-[#3D8BD0] px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#3479B8] ${FOCUS}`;
const SECONDARY = `rounded border border-[#DFE5ED] bg-white px-3 py-1.5 text-[12px] font-medium text-[#364658] transition-colors hover:bg-[#F3F4F6] ${FOCUS}`;
const FIELD = 'w-full rounded border border-[#DFE5ED] bg-white px-2.5 py-1.5 text-[13px] text-[#364658] placeholder:text-[#9CA3AF] focus:border-[#3D8BD0] focus:outline-none focus:ring-2 focus:ring-[#3D8BD0]/20';
const KINDS: Kind[] = ['SLA', 'OLA', 'UC'];
const NOUN: Record<Kind, string> = { SLA: 'SLA', OLA: 'OLA', UC: 'UC' };

/** "Tue 4:10 PM": bar ends, history and table times. */
const short = (d: Date) => `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${fmtTime(d)}`;
const range = (a: Date, b: Date) => `${short(a)} – ${a.toDateString() === b.toDateString() ? fmtTime(b) : short(b)}`;
/** datetime-local wants local "YYYY-MM-DDTHH:mm". */
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const isRunning = (r: ClockResult) => !r.stop && r.state !== 'excused';
const money = (n: number) => `$${n.toFixed(2)}`;
/** "Network Team · OLA" → "Network Team": the filter already says the kind. */
const shortName = (name: string) => name.replace(/ · (OLA|UC)$/, '');

function Chip({ label, tone }: { label: string; tone: { bg: string; text: string } }) {
  return <span className="inline-flex flex-shrink-0 items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium" style={{ backgroundColor: tone.bg, color: tone.text }}>{label}</span>;
}

export function SlaDetailsDrawer({ isOpen, onClose, focus }: Props) {
  const { scenario, clocks, edge, panelStyle } = useSla();
  const now = scenario.now;
  const [panel, setPanel] = useState<Panel>(null);
  const [history, setHistory] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('SLA');
  const [showCanceled, setShowCanceled] = useState(false);
  const [flash, setFlash] = useState<ClockId | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<ClockId | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cards = useRef<Partial<Record<ClockId, HTMLDivElement | null>>>({});

  // open: land on the clicked clock's kind (else SLA), expand it (or the most urgent SLA clock), focus the dialog, scroll to it
  useEffect(() => {
    if (!isOpen) return;
    const clicked = focus ? clocks.find(c => c.def.id === focus) : undefined;
    const kind = clicked?.def.kind ?? 'SLA';
    const lead = clicked?.def.id ?? headerSummary(clocks.filter(c => c.def.kind === kind)).clock?.def.id;
    setPanel(null); setHistory(new Set()); setShowCanceled(false); setFilter(kind); setFlash(focus); setExpanded(new Set(lead ? [lead] : [])); setSel(lead ?? null);
    const raf = requestAnimationFrame(() => {
      dialogRef.current?.focus({ preventScroll: true });
      const body = bodyRef.current, el = focus ? cards.current[focus] : null;
      if (body) body.scrollTop = el ? el.offsetTop - 20 : 0;
    });
    const t = window.setTimeout(() => setFlash(null), 1600);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(t); };
  }, [isOpen, focus]); // reset only when opened or refocused, never on a scenario edit while open
  // give focus back to whatever opened the slide-over
  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, [isOpen]);

  /** After an action: focus `target` if it still exists, else the card's header, else the dialog (an action can remove its own button). */
  const refocus = (card: string, target?: string) => requestAnimationFrame(() =>
    ((target && document.getElementById(target)) || document.getElementById(`sla-card-${card}`) || dialogRef.current)?.focus());
  const closePanel = () => {
    if (panel) refocus(panel.id, `sla-act-${panel.id}-${panel.kind}`);
    setPanel(null);
  };
  // Esc closes an open inline panel first, then the slide-over
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key !== 'Escape') return; if (!panel) return onClose(); refocus(panel.id, `sla-act-${panel.id}-${panel.kind}`); setPanel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, panel, onClose]);
  if (!isOpen) return null;

  const togglePanel = (id: string, kind: PanelKind) => setPanel(p => (p?.id === id && p.kind === kind ? null : { id, kind }));
  const toggle = (set: typeof setHistory) => (key: string) => set(p => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const toggleHistory = toggle(setHistory);
  // collapsing a card also closes its open inline panel, so Esc never closes something you can't see
  const toggleCard = (key: string) => { if (expanded.has(key) && panel?.id === key) setPanel(null); toggle(setExpanded)(key); };
  const shared = { now, scenario, panel, togglePanel, closePanel, refocus, history, toggleHistory, expanded, toggleCard };

  const canceled = canceledClocks(scenario);
  const inFilter = <T,>(list: T[], kindOf: (x: T) => Kind) => (filter === 'All' ? list : list.filter(x => kindOf(x) === filter));
  const list = inFilter(clocks, c => c.def.kind);
  const gone = inFilter(canceled, c => c.r.def.kind);
  const penalty = clocks.reduce((a, c) => a + c.penalty, 0);
  /** A filter's dot: red when a clock in it is breached, amber when one is at risk. */
  const dotOf = (k: Kind) => {
    const l = clocks.filter(c => c.def.kind === k);
    return l.some(c => c.state === 'breached') ? STATE_TONE.breached.text : l.some(c => c.state === 'risk') ? STATE_TONE.risk.text : null;
  };
  // B and C show one selected clock: the picked one if it is in the filter, else the filter's first
  const current = list.find(c => c.def.id === sel) ?? list[0];
  const filters = KINDS.filter(k => clocks.some(c => c.def.kind === k) || canceled.some(c => c.r.def.kind === k));

  return createPortal(
    <>
      <div className="fixed inset-0 z-[10000] bg-black/30" onClick={onClose} />
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="sla-history-title" className="fixed right-0 top-0 z-[10001] flex h-full w-[560px] max-w-[94vw] flex-col bg-[#F8FAFC] outline-none shadow-2xl">
        <div className="flex-shrink-0 border-b border-[#E5E7EB] bg-white px-6 py-4">
          <div className="flex items-center gap-3">
            <h2 id="sla-history-title" className="text-[18px] font-semibold text-[#111827]">Service Level History</h2>
            {penalty > 0 && <span className="ml-auto rounded bg-[#FFEBEE] px-2 py-0.5 text-[12px] font-semibold tabular-nums text-[#E74C3C]">Penalty {money(penalty)}</span>}
            <button onClick={onClose} aria-label="Close" className={`${penalty > 0 ? '' : 'ml-auto'} flex size-8 flex-shrink-0 items-center justify-center rounded text-[#6B7280] transition-colors hover:bg-[#F3F4F6] hover:text-[#111827] ${FOCUS}`}><X size={20} /></button>
          </div>
          {edge === 'nosla' && <p className="text-[13px] text-[#6B7280]">This request has no SLA. Its due time was set by hand.</p>}
          {filters.length > 0 && (
            <div role="group" aria-label="Show" className="mt-3 inline-flex rounded border border-[#DFE5ED] bg-[#F8FAFC] p-0.5">
              {[...filters, 'All' as const].map(f => {
                const on = filter === f, dot = f !== 'All' && dotOf(f), n = f === 'All' ? null : clocks.filter(c => c.def.kind === f).length;
                return (
                  <button key={f} aria-pressed={on} onClick={() => { setFilter(f); setShowCanceled(false); }}
                    className={`flex items-center gap-1.5 rounded px-3 py-1 text-[12px] font-medium transition-colors ${FOCUS} ${on ? 'bg-white text-[#364658] shadow-[0_1px_2px_rgba(16,24,40,0.08)]' : 'text-[#7B8FA5] hover:text-[#364658]'}`}>
                    {f}{n !== null && <span className="tabular-nums">{n}</span>}
                    {dot && <span aria-label="needs attention" className="size-1.5 rounded-full" style={{ backgroundColor: dot }} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div ref={bodyRef} className="relative flex-1 space-y-3 overflow-auto px-6 py-5">
          {edge === 'error' && (
            <div className="rounded-xl border border-[#EEF1F5] bg-white px-4 py-3.5 text-[13px] text-[#4A5568]">
              {LOAD_ERROR}{' '}
              <button onClick={() => setScenario('risk')} className={LINK}>Try again</button>
            </div>
          )}
          {edge === 'nosla' && <DueByCard {...shared} />}
          {edge === 'archived' && scenario.deletedOn && <p className="text-[12px] text-[#7B8FA5]">{archivedNote(scenario.deletedOn).join(' ')}</p>}
          {(panelStyle === 'A' || panelStyle === 'D') && list.map(r => (
            <div key={r.def.id} ref={el => { cards.current[r.def.id] = el; }}
              className={`rounded-r-xl transition-shadow duration-500 ${flash === r.def.id ? 'ring-2 ring-[#3D8BD0]/40' : ''}`}>
              <ClockCard r={r} steps={panelStyle === 'D'} {...shared} />
            </div>
          ))}
          {panelStyle === 'B' && list.length > 0 && <SummaryList list={list} current={current!} onPick={setSel} {...shared} />}
          {panelStyle === 'C' && list.length > 0 && <FocusView list={list} current={current!} onPick={setSel} {...shared} />}
          {filter !== 'All' && list.length === 0 && gone.length > 0 && <p className="text-[13px] text-[#7B8FA5]">No {NOUN[filter]} runs on this request now.</p>}
          {gone.length > 0 && (
            <CanceledBlock items={gone} filter={filter} open={showCanceled} onToggle={() => setShowCanceled(v => !v)} />
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

interface Shared {
  now: Date; scenario: Scenario; panel: Panel; togglePanel: (id: string, k: PanelKind) => void; closePanel: () => void;
  refocus: (card: string, target?: string) => void;
  history: Set<string>; toggleHistory: (key: string) => void; expanded: Set<string>; toggleCard: (key: string) => void;
}

/* The time bar: counted in the clock's state colour (grey before due on a late clock, red after), not counted (outside hours or a stopping status) in violet,
 * the time still left in grey. A long night is drawn short so the working day keeps the width; hover a stretch for its times. */
const NOT = '#B9B1F5';
function TimeBar({ r, scenario, now }: { r: ClockResult; scenario: Scenario; now: Date }) {
  const segs = timeline(r, scenario);
  // a late clock: the time before due stays neutral so the red past-due stretch stands out
  const run = r.breached || r.state === 'paused' || r.state === 'excused' ? '#94A3B8' : STATE_TONE[r.state].bar;
  const colour: Record<SegKind, string> = { run, not: NOT, over: STATE_TONE.breached.bar };
  const tip: Record<SegKind, string> = { run: 'Elapsed', not: '', over: 'Elapsed past due' };
  const left = isRunning(r) && r.left > 0 ? r.left : 0;
  const end = r.stop ? `${r.def.doneVerb} ${short(r.stop)}`
    : r.due ? `Due ${fmtDue(r.due, now)}${r.manual ? ', set by hand' : ''}` : 'Due time set when counting restarts';
  return (
    <div>
      <div className="flex h-2 gap-[2px]">
        {segs.map((x, i) => (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <span className={`h-full min-w-[2px] ${i === 0 ? 'rounded-l-full' : ''} ${i === segs.length - 1 && !left ? 'rounded-r-full' : ''}`}
                style={{ flex: x.kind === 'not' ? Math.min(x.mins, 90) : x.mins, backgroundColor: colour[x.kind] }} />
            </TooltipTrigger>
            <TooltipContent side="top" className="text-wrap">{x.why ?? tip[x.kind]}, {range(x.from, x.to)}</TooltipContent>
          </Tooltip>
        ))}
        {left > 0 && <span className="h-full rounded-r-full bg-[#EEF1F5]" style={{ flex: left }} />}
      </div>
      <div className="mt-1.5 flex justify-between gap-4 text-[12px] text-[#7B8FA5]">
        <span>{short(r.def.start)}</span><span className="text-right">{end}</span>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div className={`rounded-lg px-3 py-2 ${danger ? 'bg-[#FFF5F5]' : 'bg-[#F8FAFC]'}`}>
      <div className="text-[12px] text-[#7B8FA5]">{label}</div>
      <div className={`text-[15px] font-semibold tabular-nums ${danger ? 'text-[#E74C3C]' : 'text-[#111827]'}`}>
        {value}{sub && <span className="ml-1 text-[12px] font-normal text-[#7B8FA5]">{sub}</span>}
      </div>
    </div>
  );
}
function Tag({ children, tip }: { children: ReactNode; tip?: string }) {
  const tag = <span className="inline-flex items-center rounded bg-[#F8FAFC] px-2 py-0.5 text-[12px] text-[#4A5568]">{children}</span>;
  return tip ? <Tooltip><TooltipTrigger asChild>{tag}</TooltipTrigger><TooltipContent side="top" className="text-wrap">{tip}</TooltipContent></Tooltip> : tag;
}

/** Name, state chip and the big number; the policy line under it (and how a finished clock ended, while folded). */
function ClockHead({ r, open }: { r: ClockResult; open?: boolean }) {
  const { def } = r, chip = clockChip(r), done = !!r.stop || r.state === 'excused';
  const valueColor = r.state === 'ok' ? '#111827' : r.state === 'met' && def.doneVerb !== 'Handed over' ? STATE_TONE.met.text : chip.tone.text;
  return (
    <>
      <span className="flex items-center gap-2">
        <span className={`truncate text-[14px] font-semibold ${done ? 'text-[#64748B]' : 'text-[#111827]'}`}>{shortName(def.name)}</span>
        <Chip {...chip} />
        <span className={`ml-auto whitespace-nowrap pl-3 font-semibold tabular-nums ${done ? 'text-[14px]' : 'text-[17px]'}`} style={{ color: valueColor }}>{clockValue(r)}</span>
        {open !== undefined && <ChevronDown size={16} aria-hidden="true" className={`flex-shrink-0 text-[#9CA3AF] transition-transform ${open ? 'rotate-180' : ''}`} />}
      </span>
      <span className="mt-0.5 block truncate text-[12px] text-[#7B8FA5]">
        {r.stop && !open ? `${def.doneVerb} ${short(r.stop)} · ` : ''}{def.policy}
      </span>
    </>
  );
}

/* What every layout shows for one clock: the time bar and tiles (or, in D, the step timeline), the rules as tags,
 * and the history fold. `historyOpen` shows the history without the fold (layout C). */
function ClockDetails({ r, now, scenario, history, toggleHistory, steps, historyOpen }: { r: ClockResult; steps?: boolean; historyOpen?: boolean } & Shared) {
  const { def } = r, id = def.id, why = whyThis(r);
  const notCounted = timeline(r, scenario).filter(x => x.kind === 'not').reduce((a, x) => a + x.mins, 0);
  const team = shortName(def.name);
  const holder = def.kind === 'OLA' ? usage(r, scenario).find(u => u.group === team)?.who : undefined;
  const evs = events(r, scenario);
  const showHistory = historyOpen || history.has(id);
  return (
    <>
      {steps ? <>
        <p className="text-[13px] text-[#364658]">
          {fmtDur(r.counted)} of {fmtDur(r.budget)} elapsed<span className="text-[#7B8FA5]"> · {fmtDur(notCounted)} excluded</span>
          {r.penalty > 0 && <span className="ml-2 rounded bg-[#FFEBEE] px-1.5 py-0.5 text-[12px] font-semibold text-[#E74C3C]">Penalty {money(r.penalty)}</span>}
        </p>
        <Steps r={r} scenario={scenario} now={now} />
      </> : <>
        <div className="pt-1"><TimeBar r={r} scenario={scenario} now={now} /></div>
        <div className={`mt-3 grid gap-2 ${r.penalty > 0 ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <Tile label="Elapsed" value={fmtDur(r.counted)} sub={`of ${fmtDur(r.budget)}`} />
          <Tile label="Excluded" value={fmtDur(notCounted)} />
          {r.penalty > 0 && <Tile label="Penalty" value={money(r.penalty)} danger />}
        </div>
      </>}
      {r.excuse && <p className="mt-2 text-[12px] text-[#4A5568]">Excused by {r.excuse.by}: {r.excuse.reason}</p>}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Tag tip={why.hours}>{def.hours.calendar ? 'Counts 24 x 7' : def.hours.name}</Tag>
        {def.penaltyPerHour ? <Tag>${def.penaltyPerHour} per hour over</Tag> : null}
        {def.kind === 'OLA' && <Tag>{holder ? `${team}, ${holder}` : team}</Tag>}
        {def.kind === 'UC' && <Tag>{def.rule[0][2]}</Tag>}
      </div>
      {historyOpen ? <div className="mt-4 text-[12px] font-medium text-[#4A5568]">History ({evs.length})</div> : (
        <div className="mt-3.5 flex">
          <button onClick={() => toggleHistory(id)} aria-expanded={history.has(id)}
            className={`flex items-center gap-1 rounded text-[12px] font-medium text-[#4A5568] hover:text-[#111827] ${FOCUS}`}>
            History ({evs.length})
            <ChevronDown size={14} aria-hidden="true" className={`text-[#9CA3AF] transition-transform ${history.has(id) ? 'rotate-180' : ''}`} />
          </button>
        </div>
      )}
      {showHistory && <>
        <Timeline evs={evs} now={now} />
        <Usage r={r} scenario={scenario} />
      </>}
    </>
  );
}

const CARD_EDGE = (r: ClockResult) => ({ borderLeftColor: KIND_COLOUR[r.def.kind].line });

/* A and D: one folding card per clock. */
function ClockCard({ r, steps, ...shared }: { r: ClockResult; steps?: boolean } & Shared) {
  const id = r.def.id, isOpen = shared.expanded.has(id);
  return (
    <div className="rounded-r-xl border border-l-2 border-[#EEF1F5] bg-white" style={CARD_EDGE(r)}>
      <button id={`sla-card-${id}`} aria-expanded={isOpen} onClick={() => shared.toggleCard(id)} className={`block w-full rounded-r-xl px-4 py-3 text-left transition-colors hover:bg-[#FAFBFC] ${FOCUS}`}>
        <ClockHead r={r} open={isOpen} />
      </button>
      {isOpen && <div className="px-4 pb-4"><ClockDetails r={r} steps={steps} {...shared} /></div>}
    </div>
  );
}

/* B: every clock on one line (name, a thin used bar, the number); the picked one opens in full below the list. */
function SummaryList({ list, current, onPick, ...shared }: { list: ClockResult[]; current: ClockResult; onPick: (id: ClockId) => void } & Shared) {
  return (
    <>
      <div className="divide-y divide-[#F0F1F3] overflow-hidden rounded-xl border border-[#EEF1F5] bg-white">
        {list.map(r => {
          const on = r.def.id === current.def.id, chip = clockChip(r), done = !!r.stop || r.state === 'excused';
          return (
            <button key={r.def.id} onClick={() => onPick(r.def.id)} aria-pressed={on}
              className={`flex w-full items-center gap-3 border-l-2 px-4 py-2.5 text-left text-[13px] transition-colors ${FOCUS} ${on ? 'bg-[#F7FAFE]' : 'hover:bg-[#FAFBFC]'}`}
              style={CARD_EDGE(r)}>
              <span className={`min-w-0 flex-1 truncate ${on ? 'font-semibold text-[#111827]' : done ? 'text-[#64748B]' : 'font-medium text-[#364658]'}`}>{shortName(r.def.name)}</span>
              <span className="h-1 w-20 flex-shrink-0 overflow-hidden rounded-full bg-[#EEF1F5]" aria-hidden="true">
                <span className="block h-full rounded-full" style={{ width: `${Math.min(r.pct, 1) * 100}%`, backgroundColor: chip.tone.bar }} />
              </span>
              <span className="w-[112px] flex-shrink-0 text-right font-semibold tabular-nums" style={{ color: r.state === 'ok' ? '#111827' : chip.tone.text }}>{clockValue(r)}</span>
            </button>
          );
        })}
      </div>
      <div className="rounded-r-xl border border-l-2 border-[#EEF1F5] bg-white px-4 py-3.5" style={CARD_EDGE(current)}>
        <div className="mb-2"><ClockHead r={current} /></div>
        <ClockDetails r={current} {...shared} />
      </div>
    </>
  );
}

/* C: pick a clock from the chips; everything about it shows at once, history included, with no folds. */
function FocusView({ list, current, onPick, ...shared }: { list: ClockResult[]; current: ClockResult; onPick: (id: ClockId) => void } & Shared) {
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {list.map(r => {
          const on = r.def.id === current.def.id, c = KIND_COLOUR[r.def.kind];
          return (
            <button key={r.def.id} onClick={() => onPick(r.def.id)} aria-pressed={on}
              className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${FOCUS} ${on ? 'font-semibold' : 'border-[#DFE5ED] bg-white text-[#4A5568] hover:bg-[#F8FAFC]'}`}
              style={on ? { borderColor: c.line, backgroundColor: c.tint, color: c.text } : undefined}>
              {shortName(r.def.name)} · {clockValue(r)}
            </button>
          );
        })}
      </div>
      <div className="rounded-r-xl border border-l-2 border-[#EEF1F5] bg-white px-4 py-4" style={CARD_EDGE(current)}>
        <div className="mb-3"><ClockHead r={current} /></div>
        <ClockDetails r={current} historyOpen {...shared} />
      </div>
    </>
  );
}

/* D: the clock as a short story, read top to bottom — started, each stretch not counted (with why and how long),
 * counting again, past due, then how it ended or when it is due. The latest 6 steps show; the rest open on demand. */
function Steps({ r, scenario, now }: { r: ClockResult; scenario: Scenario; now: Date }) {
  const [all, setAll] = useState(false);
  const segs = timeline(r, scenario), run = r.breached ? '#94A3B8' : STATE_TONE[r.state === 'paused' || r.state === 'excused' ? 'ok' : r.state].bar;
  const steps: { at: Date; text: string; dot: string; hollow?: boolean }[] = [{ at: r.def.start, text: 'Started, counting', dot: run }];
  segs.forEach((x, i) => {
    if (x.kind === 'not') steps.push({ at: x.from, text: `${x.why}, ${fmtDur(x.mins)}`, dot: NOT });
    else if (x.kind === 'over') steps.push({ at: x.from, text: 'Past due, still counting', dot: STATE_TONE.breached.bar });
    else if (i > 0 && segs[i - 1].kind === 'not') steps.push({ at: x.from, text: 'Counting again', dot: run });
  });
  if (r.stop) steps.push({ at: r.stop, text: r.breached ? `${r.def.doneVerb}, ${fmtDur(r.counted - r.budget)} late` : `${r.def.doneVerb}, met in ${fmtDur(r.counted)}`, dot: r.breached ? STATE_TONE.breached.bar : STATE_TONE.met.bar });
  else if (r.due && !r.breached) steps.push({ at: r.due, text: 'Due', dot: run, hollow: true });
  const shown = all ? steps : steps.slice(-6);
  return (
    <div className="mt-3">
      {steps.length > 6 && !all && <button onClick={() => setAll(true)} className={`mb-2 ${LINK}`}>Show all {steps.length} steps</button>}
      <ol className="border-l border-[#E5E7EB] pl-0">
        {shown.map((x, i) => (
          <li key={i} className="relative flex gap-3 pb-2.5 pl-4 last:pb-0">
            <span aria-hidden="true" className="absolute -left-[5px] top-[5px] size-[9px] rounded-full" style={x.hollow ? { border: `2px solid ${x.dot}`, background: '#fff' } : { backgroundColor: x.dot }} />
            <span className="w-[86px] flex-shrink-0 text-[12px] tabular-nums text-[#7B8FA5]">{x.at.toDateString() === now.toDateString() ? fmtTime(x.at) : short(x.at)}</span>
            <span className={`text-[13px] ${x.hollow ? 'font-medium text-[#111827]' : 'text-[#364658]'}`}>{x.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const DOT: Record<string, string> = { breached: '#E74C3C', met: '#27AE60', 'handed-over': '#27AE60', overridden: '#3D8BD0', paused: NOT, resumed: '#94A3B8' };

/** "Today", "Yesterday", "Tue 29 Sep" — relative to the scenario's now. */
function dayLabel(d: Date, now: Date) {
  const diff = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 864e5);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
}

/* History grouped by day, newest first (the Audit Trail's day groups). The latest day is open; older days fold to one
 * line with a count, so a clock with hundreds of pause / resume lines still opens on what happened most recently. */
function Timeline({ evs, now }: { evs: ReturnType<typeof events>; now: Date }) {
  const days = [...evs].reverse().reduce<{ key: string; at: Date; list: typeof evs }[]>((out, e) => {
    const key = e.at.toDateString(), last = out[out.length - 1];
    if (last?.key === key) last.list.push(e); else out.push({ key, at: e.at, list: [e] });
    return out;
  }, []);
  const [open, setOpen] = useState<Set<string>>(() => new Set(days.slice(0, 1).map(d => d.key)));
  const flip = (key: string) => setOpen(p => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
  return (
    <div className="mt-3 border-t border-[#F0F1F3]">
      {days.map(d => (
        <section key={d.key} className="border-b border-[#F0F1F3] last:border-b-0">
          <button onClick={() => flip(d.key)} aria-expanded={open.has(d.key)}
            className={`flex w-full items-center gap-1.5 rounded py-2 text-left text-[12px] font-medium text-[#4A5568] hover:text-[#111827] ${FOCUS}`}>
            <ChevronDown size={14} aria-hidden="true" className={`text-[#9CA3AF] transition-transform ${open.has(d.key) ? '' : '-rotate-90'}`} />
            {dayLabel(d.at, now)}
            <span className="ml-auto font-normal text-[#7B8FA5]">{d.list.length} event{d.list.length > 1 ? 's' : ''}</span>
          </button>
          {open.has(d.key) && (
            <ol className="pb-2">
              {d.list.map((e, i) => {
                const last = i === d.list.length - 1;
                return (
                  <li key={i} className="flex gap-3">
                    <span className="w-[64px] flex-shrink-0 whitespace-nowrap text-[12px] leading-5 tabular-nums text-[#7B8FA5]">{fmtTime(e.at)}</span>
                    <span className="flex flex-col items-center" aria-hidden="true">
                      <span className="mt-1.5 size-2 rounded-full" style={{ backgroundColor: DOT[e.kind] ?? '#94A3B8' }} />
                      {!last && <span className="mt-1 w-px flex-1 bg-[#E5E7EB]" />}
                    </span>
                    <div className={`min-w-0 flex-1 ${last ? '' : 'pb-3'}`}>
                      <div className="text-pretty text-[13px] leading-5 text-[#364658]">{e.text}</div>
                      {e.by !== 'SLA engine' && <div className="text-[12px] text-[#7B8FA5]">by {e.by}</div>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}

/* Assignment history: who held the request while this clock ran, and the time counted with each. */
function Usage({ r, scenario }: { r: ClockResult; scenario: Scenario }) {
  const rows = usage(r, scenario);
  const th = 'pb-1.5 font-normal', td = 'py-1.5 whitespace-nowrap';
  return (
    <div className="mt-2 border-t border-[#F0F1F3] pt-3">
      <div className="mb-1.5 text-[12px] font-medium text-[#4A5568]">Assignment history</div>
      <table className="w-full text-[12px] text-[#364658]">
        <thead>
          <tr className="text-left text-[11px] text-[#7B8FA5]">
            <th className={th}>Assignee</th><th className={th}>Technician Group</th><th className={th}>From</th><th className={th}>To</th>
            <th className={`${th} pl-3 text-right`}>Elapsed</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((u, i) => (
            <tr key={i} className="border-t border-[#F0F1F3]">
              <td className={td}>{u.who}</td><td className={td}>{u.group}</td><td className={td}>{short(u.from)}</td><td className={td}>{u.to ? short(u.to) : 'Now'}</td>
              <td className={`${td} pl-3 text-right`}>{fmtDur(u.counted)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* Clocks a change replaced: one quiet line that opens to a row per clock, with what it had counted and why it ended. */
function CanceledBlock({ items, filter, open, onToggle }: { items: Canceled[]; filter: Filter; open: boolean; onToggle: () => void }) {
  const what = filter === 'All' ? `canceled clock${items.length > 1 ? 's' : ''}` : `canceled ${NOUN[filter]}${items.length > 1 ? 's' : ''}`;
  return (
    <div className="pt-1">
      <button onClick={onToggle} aria-expanded={open} className={`flex items-center gap-1 rounded text-[12px] font-medium text-[#7B8FA5] hover:text-[#364658] ${FOCUS}`}>
        {items.length} {what}
        <ChevronDown size={14} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="mt-2 divide-y divide-[#F0F1F3] rounded-xl border border-[#EEF1F5] bg-white">
          {items.map(({ r, at, why, by }) => {
            const finishedFirst = !!r.stop && r.def.doneVerb !== 'Canceled';
            return (
              <div key={`${r.def.kind}-${r.def.name}-${at.getTime()}`} className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: KIND_COLOUR[r.def.kind].line }} aria-hidden="true" />
                  <span className="text-[13px] font-medium text-[#64748B]">{shortName(r.def.name)}</span>
                  <Chip label="Canceled" tone={STATE_TONE.excused} />
                  <span className="ml-auto text-[12px] tabular-nums text-[#64748B]">
                    {finishedFirst ? `Met in ${fmtDur(r.counted)} before it ended` : `${fmtDur(r.counted)} elapsed of ${fmtDur(r.def.target)}`}
                  </span>
                </div>
                <div className="mt-0.5 pl-3.5 text-[12px] text-[#7B8FA5]">{r.def.policy}. {why}, {short(at)}, by {by}.</div>
              </div>
            );
          })}
        </div>
      )}
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

/* No SLA: one hand-set Due By, which can be moved and moved back. */
function DueByCard({ now, scenario, panel, togglePanel, closePanel }: Shared) {
  const due = scenario.dueBy!, original = SCENARIOS.nosla.dueBy!;
  const left = Math.round((due.getTime() - now.getTime()) / 60000), over = left <= 0;
  const tone = over ? STATE_TONE.breached : STATE_TONE.ok;
  return (
    <div className="rounded-xl border border-[#EEF1F5] bg-white px-4 pb-4 pt-3.5">
      <span className="flex items-center gap-2">
        <span className="text-[14px] font-semibold text-[#111827]">Due By, set by hand</span>
        <Chip label={over ? 'Breached' : 'On track'} tone={tone} />
        <span className="ml-auto text-[17px] font-semibold tabular-nums" style={{ color: over ? tone.text : '#111827' }}>{over ? `${fmtDur(-left)} over` : `${fmtDur(left)} left`}</span>
      </span>
      <p className="mt-1 text-[12px] text-[#7B8FA5]">Due {fmtDue(due, now)}, set by {ME}</p>
      <div className="mt-3 flex gap-4">
        <button id="sla-act-dueby-due" aria-expanded={panel?.id === 'dueby'} onClick={() => togglePanel('dueby', 'due')} className={LINK}>Change due time</button>
        {due.getTime() !== original.getTime() && <button onClick={() => setDueBy(original)} className={LINK}>Use original time again</button>}
      </div>
      {panel?.id === 'dueby' && <ChangeDue id="dueby" initial={due} now={now} onCancel={closePanel} onSave={d => { setDueBy(d); closePanel(); }} />}
    </div>
  );
}
