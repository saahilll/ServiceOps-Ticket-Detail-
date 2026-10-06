import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import {
  useSla, setManualDue, segments, whyLine, previousClocks, finishedLine, PREVIOUS, fmtDur, fmtTime, fmtWhen,
  STATE_LABEL, STATE_TONE, type ClockId, type ClockResult, type Scenario,
} from './slaEngine';

/* SLA details — the designers' SLA History side drawer (560px, white header, #F8FAFC body, white cards).
 * Three tabs by agreement type: SLA (response + resolution, penalty, earlier SLA in full) · OLA (team targets) · UC (vendor).
 * Every target row opens to show how it's counted. */

interface Props { isOpen: boolean; onClose: () => void; focus: ClockId; editing?: boolean }

type Kind = 'SLA' | 'OLA' | 'UC';
const SEG = { run: '#3D8BD0', pause: '#A9B4C6', over: '#E74C3C', off: 'repeating-linear-gradient(135deg,#F1F3F6 0 4px,#E3E7ED 4px 6px)' };
const DAY = 9 * 60; // business day = 9h (Mon–Fri 9–6)
const target = (m: number) => (m >= DAY && m % DAY === 0 ? `${m / DAY} business days` : fmtDur(m));

export function SlaDetailsDrawer({ isOpen, onClose, focus, editing }: Props) {
  const { scenario, clocks } = useSla();
  const [open, setOpen] = useState<Set<ClockId>>(new Set([focus]));
  const [edit, setEdit] = useState<ClockId | null>(editing ? focus : null);
  const [tab, setTab] = useState<Kind>('SLA');
  const refs = useRef<Partial<Record<ClockId, HTMLDivElement | null>>>({});
  useEffect(() => {
    if (!isOpen) return;
    setOpen(new Set([focus])); setEdit(editing ? focus : null);
    setTab(clocks.find(c => c.def.id === focus)?.def.kind ?? 'SLA');
    requestAnimationFrame(() => refs.current[focus]?.scrollIntoView({ block: 'center' }));
  }, [isOpen, focus, editing]);
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);
  if (!isOpen) return null;

  const toggle = (id: ClockId) => setOpen(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const customer = clocks.filter(c => c.def.kind === 'SLA');
  const teams = clocks.filter(c => c.def.kind === 'OLA');
  const vendor = clocks.filter(c => c.def.kind === 'UC');
  const tabs = (['SLA', 'OLA', 'UC'] as Kind[]).filter(k => clocks.some(c => c.def.kind === k));
  const alert = (k: Kind) => clocks.filter(c => c.def.kind === k).find(c => c.state === 'breached' || c.state === 'missed' || c.state === 'risk');
  const penalty = customer.reduce((a, c) => a + c.penalty, 0);
  const rate = customer.find(c => c.def.penaltyPerHour)?.def.penaltyPerHour;
  const row = (r: ClockResult) => (
    <div key={r.def.id} ref={el => { refs.current[r.def.id] = el; }} className="[&:first-child>div]:border-t-0">
      <TargetRow r={r} s={scenario} open={open.has(r.def.id)} onToggle={() => toggle(r.def.id)}
        editing={edit === r.def.id} onEdit={() => { setEdit(r.def.id); setOpen(p => new Set(p).add(r.def.id)); }} onEditDone={() => setEdit(null)} />
    </div>
  );

  return createPortal(
    <>
      <div className="fixed inset-0 bg-black/30 z-[10000]" onClick={onClose} />
      <div role="dialog" aria-label="SLA details" className="fixed top-0 right-0 h-full w-[560px] max-w-[94vw] bg-[#F8FAFC] shadow-2xl z-[10001] flex flex-col">
        <div className="flex items-start justify-between px-6 pt-4 pb-2 bg-white flex-shrink-0">
          <div>
            <h2 className="text-[18px] font-semibold text-[#111827]">SLA details</h2>
            <p className="text-[13px] text-[#6B7280] mt-0.5">As of {fmtTime(scenario.now)}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="flex size-8 flex-shrink-0 items-center justify-center rounded hover:bg-[#F3F4F6] text-[#6B7280] hover:text-[#111827]"><X size={20} /></button>
        </div>
        {/* same underline tabs as the ticket's main tabs */}
        <div role="tablist" className="flex gap-6 px-6 bg-white border-b border-[#E5E7EB] flex-shrink-0">
          {tabs.map(k => {
            const a = alert(k);
            return (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`flex items-center gap-1.5 py-2.5 text-[14px] font-medium border-b-2 -mb-px ${tab === k ? 'text-[#3D8BD0] border-[#3D8BD0]' : 'text-[#6b7280] border-transparent hover:text-[#364658]'}`}>
                {k}
                {a && <span className="size-1.5 rounded-full" style={{ backgroundColor: STATE_TONE[a.state].text }} />}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-auto px-6 py-5 space-y-4">
          {tab === 'SLA' && <>
          <Section title="Customer SLA">
            {customer.map(row)}
            <div className="flex items-center justify-between border-t border-[#F0F1F3] px-4 py-3">
              <div>
                <div className="text-[13px] font-medium text-[#364658]">Penalty</div>
                <div className="text-[12px] text-[#7B8FA5]">{rate ? `$${rate} per started hour over the resolution target` : 'No penalty on this SLA'}</div>
              </div>
              <span className={`rounded px-2 py-0.5 text-[13px] font-semibold tabular-nums ${penalty > 0 ? 'bg-[#FFEBEE] text-[#E74C3C]' : 'bg-[#F3F4F6] text-[#364658]'}`}>${penalty.toFixed(2)}</span>
            </div>
          </Section>

          <Previous />
          </>}

          {tab === 'OLA' && <Section>{teams.map(row)}</Section>}
          {tab === 'UC' && <Section>{vendor.map(row)}</Section>}
        </div>
      </div>
    </>,
    document.body,
  );
}

function Section({ title, sub, children, muted }: { title?: string; sub?: string; children: React.ReactNode; muted?: boolean }) {
  return (
    <section className={`rounded-xl border border-[#EEF1F5] shadow-[0_1px_2px_rgba(16,24,40,0.04)] ${muted ? 'bg-[#FBFCFD]' : 'bg-white'}`}>
      {title && (
        <div className="flex items-baseline gap-2 px-4 pt-3.5 pb-2">
          <h3 className="text-[14px] font-semibold text-[#111827]">{title}</h3>
          {sub && <span className="text-[12px] text-[#7B8FA5]">{sub}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

function Pill({ r, label }: { r: ClockResult; label?: string }) {
  const t = label ? { bg: '#F3F4F6', text: '#6B7280' } : STATE_TONE[r.state];
  return <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold flex-shrink-0" style={{ backgroundColor: t.bg, color: t.text }}>{label ?? STATE_LABEL[r.state]}</span>;
}

const valueOf = (r: ClockResult) => {
  const over = r.state === 'breached' || r.state === 'missed';
  return r.state === 'met' ? `Met in ${fmtDur(r.counted)}` : over ? `${fmtDur(Math.abs(r.counted - r.def.target))} over` : `${fmtDur(r.left)} left`;
};
const whenOf = (r: ClockResult) => {
  const over = r.state === 'breached' || r.state === 'missed';
  return r.stop ? finishedLine(r, true) : r.due ? `${over ? 'Was due' : 'Due'} ${fmtWhen(r.due)}` : 'Paused, waiting on customer';
};

/* One target: summary row, opens to the math. */
function TargetRow({ r, s, open, onToggle, editing, onEdit, onEditDone }: {
  r: ClockResult; s: Scenario; open: boolean; onToggle: () => void; editing: boolean; onEdit: () => void; onEditDone: () => void;
}) {
  const t = STATE_TONE[r.state];
  const urgent = r.state === 'risk' || r.state === 'breached';
  const why = whyLine(r);
  return (
    <div className="border-t border-[#F0F1F3]">
      <button onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#FAFBFC]">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[#364658]">{r.def.kind === 'SLA' ? r.def.name : r.def.name.replace(/^(OLA|UC) · /, '')}</div>
          <div className="text-[12px] text-[#7B8FA5]">{whenOf(r)}</div>
        </div>
        <span className="text-[14px] font-semibold tabular-nums" style={{ color: r.state === 'ok' || r.state === 'met' ? '#111827' : t.text }}>{valueOf(r)}</span>
        <Pill r={r} />
        <ChevronDown size={16} className={`text-[#9CA3AF] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4">
          {why && <p className="mb-3 text-[13px] text-[#6B7280]">{why}</p>}
          <Counted r={r} s={s} />
          {!r.stop && !editing && (
            <button onClick={onEdit}
              className={`mt-3 rounded-md px-3 py-1.5 text-[12px] font-medium ${urgent ? 'bg-[#3D8BD0] text-white hover:bg-[#3479B8]' : 'border border-[#DFE5ED] bg-white text-[#364658] hover:bg-[#F5F7FA]'}`}>
              Change due time
            </button>
          )}
          {editing && !r.stop && <ChangeDue r={r} onDone={onEditDone} />}
        </div>
      )}
    </div>
  );
}

/* Why this number: every minute since the clock started is counted, paused, or outside business hours. */
function Counted({ r, s }: { r: ClockResult; s: Scenario }) {
  const segs = segments(r, s);
  const Row = ({ c, k, v, bold }: { c: string; k: string; v: string; bold?: boolean }) => (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className="size-2.5 rounded-sm flex-shrink-0" style={{ background: c }} />
      <span className={`text-[13px] ${bold ? 'font-semibold text-[#111827]' : 'text-[#364658]'}`}>{k}</span>
      <span className={`ml-auto text-[13px] tabular-nums ${bold ? 'font-semibold text-[#111827]' : 'text-[#364658]'}`}>{v}</span>
    </div>
  );
  return (
    <div className="rounded-lg bg-[#F8FAFC] p-3">
      <div className="flex h-2.5 rounded-full overflow-hidden bg-[#EEF1F5]">
        {segs.map(([k, n], i) => <span key={i} style={{ flex: n, background: SEG[k] }} />)}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-[#9CA3AF] tabular-nums">
        <span>Started {fmtWhen(r.def.start)}</span><span>{r.stop ? fmtWhen(r.stop) : 'Now'}</span>
      </div>
      <div className="mt-2">
        <Row c={SEG.run} k="Counted" v={`${fmtDur(r.counted)} of ${fmtDur(r.def.target)}`} bold />
        <Row c={SEG.pause} k="Paused (waiting for customer)" v={fmtDur(r.paused)} />
        {!r.def.hours.calendar && <Row c={SEG.off} k="Nights and weekends" v={fmtDur(r.outside)} />}
      </div>
      <p className="mt-2 text-[12px] text-[#9CA3AF]">{r.def.policy}. {r.def.hours.calendar ? 'Counts 24 x 7.' : `${r.def.hours.name}: ${r.def.hours.line}.`}</p>
    </div>
  );
}

/* The earlier SLA, in full: what it was, why it applied, what it had counted, and why it was canceled. */
function Previous() {
  const { scenario } = useSla();
  const prev = previousClocks(scenario);
  return (
    <Section title="Earlier SLA" sub={`${PREVIOUS.policy} · canceled`} muted>
      <div className="px-4 pb-3 text-[13px] text-[#364658]">
        {PREVIOUS.change} by <span className="text-[#3D8BD0] font-medium">{PREVIOUS.by}</span> on {fmtWhen(PREVIOUS.canceledAt)}.
        <span className="text-[#6B7280]"> The new SLA counts from when the request was created, so time already spent carries over.</span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 border-t border-[#F0F1F3] px-4 py-3">
        <Field k="Applied" v={fmtWhen(PREVIOUS.appliedAt)} />
        <Field k="Canceled" v={fmtWhen(PREVIOUS.canceledAt)} />
        <Field k="Applied because" v={PREVIOUS.rule.map(([f, , v]) => `${f} is ${v}`).join(' and ')} />
        <Field k="Penalty" v={PREVIOUS.penaltyRule} />
      </div>
      {prev.map(r => {
        // a target finished under this SLA only if it stopped before the cancel; anything else was cut off by it
        const done = r.def.id === 'first' && !!r.stop;
        return (
          <div key={r.def.id} className="flex items-center gap-3 border-t border-[#F0F1F3] px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-[#364658]">{r.def.name}</div>
              <div className="text-[12px] text-[#7B8FA5]">
                Target {target(r.def.target)} · {done ? `replied ${fmtTime(r.stop!)}` : r.def.id === 'first' ? 'no reply before the change' : `would have been due ${fmtWhen(r.policyDue)}`}
              </div>
            </div>
            <span className="text-[13px] tabular-nums text-[#364658]">{done ? valueOf(r) : `${fmtDur(r.counted)} counted`}</span>
            <Pill r={r} label={done ? undefined : 'Canceled'} />
          </div>
        );
      })}
    </Section>
  );
}

const Field = ({ k, v }: { k: string; v: string }) => (
  <div className="min-w-0"><div className="text-[11px] text-[#7B8FA5]">{k}</div><div className="text-[13px] text-[#364658]">{v}</div></div>
);

/* What can I do: move the due time, with a reason that goes to the audit trail. */
function ChangeDue({ r, onDone }: { r: ClockResult; onDone: () => void }) {
  const base = r.due ?? r.policyDue;
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [when, setWhen] = useState(local(base));
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const save = () => {
    if (!reason.trim()) { setError('Add a reason. It shows in the audit trail.'); return; }
    setManualDue(r.def.id, new Date(when), reason.trim());
    onDone();
  };
  return (
    <div className="mt-3 rounded-lg border border-[#3D8BD0] bg-white p-3">
      <label htmlFor={`due-${r.def.id}`} className="block text-[12px] text-[#6B7280]">New due time</label>
      <input id={`due-${r.def.id}`} type="datetime-local" value={when} onChange={e => setWhen(e.target.value)}
        className="mt-1 w-full rounded-md border border-[#DFE5ED] px-3 py-1.5 text-[13px] text-[#111827]" />
      <label htmlFor={`reason-${r.def.id}`} className="mt-3 block text-[12px] text-[#6B7280]">Reason</label>
      <textarea id={`reason-${r.def.id}`} rows={2} value={reason} onChange={e => { setReason(e.target.value); setError(''); }}
        placeholder="Customer agreed to a 5:30 PM fix window on the call"
        className="mt-1 w-full rounded-md border border-[#DFE5ED] px-3 py-2 text-[13px] text-[#111827] placeholder:text-[#9CA3AF]" />
      {error && <p className="mt-1 text-[12px] text-[#E74C3C]">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button onClick={save} className="rounded-md bg-[#3D8BD0] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#3479B8]">Save due time</button>
        <button onClick={onDone} className="rounded-md border border-[#DFE5ED] bg-white px-3 py-1.5 text-[12px] font-medium text-[#364658] hover:bg-[#F5F7FA]">Cancel</button>
      </div>
    </div>
  );
}
