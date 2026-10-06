import { useSyncExternalStore } from 'react';

/* SLA engine — ONE calculation feeds the header pill, the SLA Status card and the SLA details drawer,
 * so no two surfaces can disagree. That is the feature: today the SLA tab and the SLA report reach
 * "Elapsed Time" through different business-hour lookups and customers see two numbers.
 *
 * Rules (mirroring the backend's SlaAppliedHistory model):
 *   a minute counts toward a target only when it is inside business hours AND the clock is not paused.
 *   Business hours: Mon–Fri 09:00–18:00. Pausing is driven by status (Status.slaOff).
 * Demo timeline is fixed in Sep 2026 so the numbers never drift with the real clock. */

const MIN = 60_000;
export const D = (d: number, h: number, m: number) => new Date(2026, 8, d, h, m);

export interface Pause { from: Date; to: Date | null; why: string }
export interface ManualDue { due: Date; by: string; at: Date; reason: string }
export interface Scenario {
  key: ScenarioKey; label: string; now: Date; pauses: Pause[];
  resolved?: Date; firstReply?: Date; noReply?: boolean; manual?: Partial<Record<ClockId, ManualDue>>; status: string;
}
export type ScenarioKey = 'ok' | 'overdue' | 'late' | 'risk' | 'paused' | 'breached' | 'met' | 'manual';

/* Business hours come from the technician group (SlaPolicyCalculatorServiceImpl.calculateSLA:
 * "identify bizhour from technician group"); a calendar-hours policy counts 24x7 (SlaOperationalHourType.CALENDAR_HOURS). */
export interface Hours { name: string; line: string; calendar?: boolean }
const NETWORK_HOURS: Hours = { name: 'Network Team hours', line: 'Mon–Fri, 9 AM – 6 PM IST' };
const DESK_HOURS: Hours = { name: 'Service Desk hours', line: 'Mon–Fri, 9 AM – 6 PM IST' };
const ALL_HOURS: Hours = { name: 'Calendar hours', line: '24 x 7', calendar: true };
const wfc = (from: Date, to: Date | null): Pause => ({ from, to, why: 'Pending (Waiting for Customer)' });

export const SCENARIOS: Record<ScenarioKey, Scenario> = {
  ok: { key: 'ok', label: 'On track', now: D(30, 10, 15), pauses: [], status: 'In Progress' },
  /* The Neysa case, in two steps. The response was due 4:40 PM.
     1) No reply yet at 5:10 PM: it must already read Breached (today's product waits until resolve). */
  overdue: { key: 'overdue', label: 'Reply overdue', now: D(29, 17, 10), pauses: [], noReply: true, status: 'In Progress' },
  /* 2) Reply sent at 5:15 PM, after due: still Breached, never Achieved. */
  late: { key: 'late', label: 'Late reply', now: D(29, 17, 30), pauses: [], firstReply: D(29, 17, 15), status: 'In Progress' },
  risk: { key: 'risk', label: 'At risk', now: D(30, 15, 5), pauses: [wfc(D(30, 10, 30), D(30, 11, 40))], status: 'In Progress' },
  paused: { key: 'paused', label: 'Paused', now: D(30, 15, 5), pauses: [wfc(D(30, 10, 30), D(30, 11, 40)), wfc(D(30, 14, 40), null)], status: 'Pending' },
  breached: { key: 'breached', label: 'Breached', now: D(30, 17, 5), pauses: [wfc(D(30, 10, 30), D(30, 11, 40))], status: 'In Progress' },
  met: { key: 'met', label: 'Resolved', now: D(30, 15, 5), pauses: [wfc(D(30, 10, 30), D(30, 11, 40))], resolved: D(30, 14, 12), status: 'Resolved' },
  manual: {
    key: 'manual', label: 'Due set by hand', now: D(30, 15, 5), pauses: [wfc(D(30, 10, 30), D(30, 11, 40))], status: 'In Progress',
    manual: { resolution: { due: D(30, 17, 30), by: 'Sarah Johnson', at: D(30, 14, 50), reason: 'Customer agreed on the 2:45 PM call to a 5:30 PM fix window.' } },
  },
};

export type ClockId = 'first' | 'resolution' | 'ola-desk' | 'ola-network' | 'uc';
export interface ClockDef {
  id: ClockId; kind: 'SLA' | 'OLA' | 'UC'; name: string; short: string; start: Date; target: number; hours: Hours;
  /** Penalty rule (SlaPenalty: penaltyPerUnit per started unit over target). */
  penaltyPerHour?: number;
  stop: (s: Scenario) => Date | undefined; stopWhy: string; startWhy: string;
  /** What stopping this clock is called on screen: Replied, Resolved, Handed over, Restored. */
  doneVerb: string;
  policy: string; rule: [string, string, string][];
  /** The SLA this one replaced when a condition changed. The old target is canceled and kept for visibility;
   *  the new one is recalculated from request creation (SlaPolicyCalculatorServiceImpl.calculateSLA uses
   *  ticket createdTime + totalSlaPauseTime), so time already spent counts against the new target. */
  replaced?: { policy: string; target: string; at: Date; change: string; by: string };
}
const P2_RULE: [string, string, string][] = [['Priority', 'is', 'High'], ['Category', 'is', 'Network']];
const UC_RESTORED = D(30, 13, 55);
export const CLOCKS: ClockDef[] = [
  { id: 'first', kind: 'SLA', name: 'First response', short: 'Response', start: D(29, 16, 10), target: 30, hours: NETWORK_HOURS, stop: s => (s.noReply ? undefined : s.firstReply ?? D(29, 16, 24)),
    stopWhy: 'first reply sent to the requester', doneVerb: 'Replied', startWhy: 'Request created', policy: 'P2 High – Response SLA', rule: P2_RULE },
  { id: 'resolution', kind: 'SLA', name: 'Resolution', short: 'Resolution', start: D(29, 16, 10), target: 480, hours: NETWORK_HOURS, stop: s => s.resolved,
    stopWhy: 'request resolved', doneVerb: 'Resolved', startWhy: 'Request created', policy: 'P2 High – Resolution SLA', rule: P2_RULE, penaltyPerHour: 50,
    replaced: { policy: 'P3 Standard – Resolution SLA', target: '3 days', at: D(29, 17, 2), change: 'priority changed from Medium to High', by: 'Sarah Johnson' } },
  /* A policy can carry one OLA per technician group, in order (SlaPolicy.olaConfigSet, OlaConfig.groupIds / olaOrder). */
  { id: 'ola-desk', kind: 'OLA', name: 'OLA · Service Desk', short: 'OLA 1', start: D(29, 16, 10), target: 90, hours: DESK_HOURS, stop: () => D(29, 17, 20),
    stopWhy: 'request moved to Network Team', doneVerb: 'Handed over', startWhy: 'Assigned to Service Desk', policy: 'P2 High – OLA 1 (Service Desk, 1h 30m)', rule: [['Technician group', 'is', 'Service Desk']] },
  { id: 'ola-network', kind: 'OLA', name: 'OLA · Network Team', short: 'OLA 2', start: D(29, 17, 20), target: 240, hours: NETWORK_HOURS, stop: s => s.resolved,
    stopWhy: 'request resolved', doneVerb: 'Resolved', startWhy: 'Assigned to Network Team', policy: 'P2 High – OLA 2 (Network Team, 4h)', rule: [['Technician group', 'is', 'Network Team']] },
  /* Underpinning contract with the vendor — shown only when one applies (SlaHistoryType.UC). 24x7 contract. */
  { id: 'uc', kind: 'UC', name: 'UC · Airtel Business', short: 'UC', start: D(30, 9, 40), target: 240, hours: ALL_HOURS,
    stop: s => (s.resolved && s.resolved < UC_RESTORED ? s.resolved : s.now >= UC_RESTORED ? UC_RESTORED : undefined),
    stopWhy: 'vendor restored the link', doneVerb: 'Restored', startWhy: 'Link fault logged with the vendor', policy: 'Airtel Business – Link restore UC (4h, 24x7)', rule: [['Vendor', 'is', 'Airtel Business']] },
];

const isWork = (t: Date) => { const w = t.getDay(), h = t.getHours(); return w >= 1 && w <= 5 && h >= 9 && h < 18; };
const inPause = (t: Date, ps: Pause[]) => ps.some(p => t >= p.from && t < (p.to ?? new Date(8.64e15)));
function count(a: Date, b: Date, fn: (t: Date) => boolean) {
  let n = 0;
  for (let t = a.getTime(); t < b.getTime(); t += MIN) if (fn(new Date(t))) n++;
  return n;
}
function walk(start: Date, mins: number, fn: (t: Date) => boolean) {
  let t = start.getTime(), c = 0;
  while (c < mins) { if (fn(new Date(t))) c++; t += MIN; }
  return new Date(t);
}

export type ClockState = 'ok' | 'risk' | 'paused' | 'breached' | 'met' | 'missed';
export interface ClockResult {
  def: ClockDef; state: ClockState; stop?: Date; end: Date;
  calendar: number; outside: number; paused: number; counted: number;
  left: number; due: Date | null; policyDue: Date; firstDue: Date; early: number;
  /** Business minutes spent in pauses that have ENDED — only these have moved the due time. */
  pausedClosed: number;
  pausedNow?: Pause; manual?: ManualDue;
  penalty: number;
}


export function calc(def: ClockDef, s: Scenario): ClockResult {
  const planned = def.stop(s), stop = planned && planned <= s.now ? planned : undefined;  // a stop that hasn't happened yet doesn't count
  const end = stop ?? s.now, ps = s.pauses;
  const pausedNow = stop ? undefined : ps.find(p => !p.to && p.from <= end);
  const isBiz = def.hours.calendar ? () => true : isWork;
  const biz = count(def.start, end, isBiz);
  const counted = count(def.start, end, t => isBiz(t) && !inPause(t, ps));
  const calendar = Math.round((end.getTime() - def.start.getTime()) / MIN);
  const firstDue = walk(def.start, def.target, isBiz);
  const policyDue = walk(def.start, def.target, t => isBiz(t) && !inPause(t, ps.filter(p => p.to)));
  let due: Date | null = pausedNow && policyDue > end ? null : policyDue; // paused short of target: due unknown until restart
  const manual = s.manual?.[def.id];
  let left = def.target - counted;
  if (manual) {
    due = manual.due;
    left = s.now < due ? count(s.now, due, t => isBiz(t) && !inPause(t, ps)) : -count(due, s.now, isBiz);
  }
  let state: ClockState;
  if (stop) state = (manual ? stop <= manual.due : counted <= def.target) ? 'met' : 'missed';
  else if (left <= 0) state = 'breached';
  else if (pausedNow) state = 'paused';
  else state = left < def.target * 0.25 ? 'risk' : 'ok'; // at risk = under a quarter of the target left
  const early = state === 'met' && due && stop ? count(stop, due, t => isBiz(t) && !inPause(t, ps)) : 0;
  const pausedClosed = count(def.start, end, t => isBiz(t) && inPause(t, ps.filter(p => p.to)));
  const over = Math.max(0, counted - def.target);
  const penalty = def.penaltyPerHour && !manual && over > 0 ? Math.ceil(over / 60) * def.penaltyPerHour : 0;
  return { penalty, pausedClosed, def, state, stop, end, calendar, outside: calendar - biz, paused: biz - counted, counted, left, due, policyDue, firstDue, early, pausedNow, manual };
}

export type SegKind = 'run' | 'off' | 'pause' | 'over';
export function segments(r: ClockResult, s: Scenario): [SegKind, number][] {
  const out: [SegKind, number][] = [];
  const dueT = r.due && r.state !== 'met' ? r.due.getTime() : Infinity;
  let cur: SegKind | null = null, n = 0;
  for (let t = r.def.start.getTime(); t < r.end.getTime(); t += MIN) {
    const d = new Date(t);
    const k: SegKind = !r.def.hours.calendar && !isWork(d) ? 'off' : inPause(d, s.pauses) ? 'pause' : t >= dueT ? 'over' : 'run';
    if (k !== cur) { if (cur) out.push([cur, n]); cur = k; n = 0; }
    n++;
  }
  if (cur) out.push([cur, n]);
  return out;
}

/* formatting */
export const fmtDur = (m: number) => {
  m = Math.round(Math.abs(m));
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h}h ${String(r).padStart(2, '0')}m` : `${h}h`) : `${r}m`;
};
export const fmtTime = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const fmtDay = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
export const fmtWhen = (d: Date) => `${fmtDay(d)}, ${fmtTime(d)}`;

export const STATE_LABEL: Record<ClockState, string> = { ok: 'On track', risk: 'At risk', paused: 'Paused', breached: 'Breached', met: 'Met', missed: 'Breached' };  // a clock that stopped after its due time is Breached, not Achieved
/* Tones reuse the ticket page's own SLA pill palette (green / amber / red) plus a neutral grey for paused. */
export const STATE_TONE: Record<ClockState, { bg: string; text: string; bar: string }> = {
  ok: { bg: '#E8F5E9', text: '#27AE60', bar: '#27AE60' },
  met: { bg: '#E8F5E9', text: '#27AE60', bar: '#27AE60' },
  risk: { bg: '#FFF3E0', text: '#F39C12', bar: '#F39C12' },
  breached: { bg: '#FFEBEE', text: '#E74C3C', bar: '#E74C3C' },
  missed: { bg: '#FFEBEE', text: '#E74C3C', bar: '#E74C3C' },
  paused: { bg: '#EEF1F6', text: '#5B6B86', bar: '#9AA8C0' },
};

/** Short value for pills: "1h 15m left", "45m over", "Paused", "Met". */
export function shortValue(r: ClockResult) {
  switch (r.state) {
    case 'ok': case 'risk': return `${fmtDur(r.left)} left`;
    case 'paused': return 'Paused';
    case 'breached': return `${fmtDur(-r.left)} over`;
    case 'met': return r.def.id === 'first' ? `${fmtDur(r.counted)}` : `${fmtDur(r.counted)}`;
    case 'missed': return `${fmtDur(r.counted - r.def.target)} over`;
  }
}

/* tiny shared store so every surface reads the same scenario */
let current: ScenarioKey = 'risk';
let edits: Partial<Record<ClockId, ManualDue>> = {};   // due times changed with the pencil (existing feature)
let version = 0;
const subs = new Set<() => void>();
const bump = () => { version++; subs.forEach(f => f()); };
export const setScenario = (k: ScenarioKey) => { current = k; edits = {}; bump(); };
/** The existing "edit SLA date" pencil. Same rule as the backend's dueTimeManuallyUpdated: the hand-set time wins. */
export const setManualDue = (id: ClockId, due: Date, reason: string) => {
  edits = { ...edits, [id]: { due, by: 'Sarah Johnson', at: SCENARIOS[current].now, reason } }; bump();
};
const scenarioNow = (): Scenario => {
  const s = SCENARIOS[current];
  return Object.keys(edits).length ? { ...s, manual: { ...s.manual, ...edits } } : s;
};
export function useSla() {
  useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => version);
  const s = scenarioNow();
  // a clock shows only once it applies (e.g. the UC starts when the fault is logged with the vendor)
  return { scenario: s, clocks: CLOCKS.filter(c => c.start <= s.now).map(c => calc(c, s)) };
}

/** The one demo request the new SLA experience runs on. */
export const SLA_DEMO_ID = 'INC-32';
/** Non-hook read for list cells (the grid pill for the demo request). */
export function slaSnapshot() {
  const s = scenarioNow();
  return { scenario: s, resolution: calc(CLOCKS[1], s) };
}

/** One plain sentence on why the clock reads the way it does — only when there is something to explain. */
export function whyLine(r: ClockResult): string | null {
  if (r.pausedNow && r.state === 'paused') return `Paused since ${fmtTime(r.pausedNow.from)} while waiting for the customer.`;
  if (r.manual) return `Due set by hand by ${r.manual.by}${r.manual.reason ? `: "${r.manual.reason}"` : ''}. The policy said ${fmtTime(r.policyDue)}.`;
  if (r.state === 'met' && r.early) return `Finished ${fmtDur(r.early)} before it was due.`;
  if (r.pausedClosed && r.due && r.firstDue.getTime() !== r.policyDue.getTime() && !r.stop && r.state !== 'breached')
    return `Due moved from ${fmtTime(r.firstDue)} because the clock was paused ${fmtDur(r.pausedClosed)}.`;
  return null;
}


/* The SLA that applied before the priority change. Kept in full for visibility (SlaTargetStatus.CANCELED).
 * Its clocks ran from request creation until the change; the new SLA then recounts from creation. */
const PREV_RULE: [string, string, string][] = [['Priority', 'is', 'Medium'], ['Category', 'is', 'Network']];
export const PREVIOUS = {
  policy: 'P3 Standard', appliedAt: D(29, 16, 10), canceledAt: D(29, 17, 2), by: 'Sarah Johnson',
  change: 'Priority changed from Medium to High', rule: PREV_RULE, penaltyRule: 'No penalty on this SLA',
  clocks: [
    { id: 'first', kind: 'SLA', name: 'First response', short: 'Response', start: D(29, 16, 10), target: 60, hours: NETWORK_HOURS,
      stop: s => (s.noReply ? undefined : s.firstReply ?? D(29, 16, 24)), stopWhy: 'first reply sent to the requester', doneVerb: 'Replied', startWhy: 'Request created', policy: 'P3 Standard – Response SLA', rule: PREV_RULE },
    { id: 'resolution', kind: 'SLA', name: 'Resolution', short: 'Resolution', start: D(29, 16, 10), target: 27 * 60, hours: NETWORK_HOURS,
      stop: () => D(29, 17, 2), stopWhy: 'SLA canceled', doneVerb: 'Canceled', startWhy: 'Request created', policy: 'P3 Standard – Resolution SLA', rule: PREV_RULE },
  ] as ClockDef[],
};
/** The earlier SLA's clocks, frozen at the moment it was canceled (no pauses had happened yet). */
export const previousClocks = (s?: Scenario) => PREVIOUS.clocks.map(c => calc(c, { ...SCENARIOS.ok, now: PREVIOUS.canceledAt, pauses: [], manual: undefined, resolved: undefined,
  // a reply after the cancel time belongs to the new SLA, not this one
  noReply: !!s?.noReply || (!!s?.firstReply && s.firstReply > PREVIOUS.canceledAt), firstReply: s?.firstReply }));

/** How a stopped clock finished, in plain words: "Replied 4:52 PM, 12m after due". */
export function finishedLine(r: ClockResult, long = false) {
  if (!r.stop) return '';
  const at = long ? fmtWhen(r.stop) : fmtTime(r.stop);
  return r.state === 'missed'
    ? `${r.def.doneVerb} ${at}, ${fmtDur(r.counted - r.def.target)} late`
    : `${r.def.doneVerb} ${at}`;
}
