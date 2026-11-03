import { useSyncExternalStore } from 'react';

/* SLA engine — ONE calculation feeds the header pill, the SLA Status card and the SLA details drawer,
 * so no two surfaces can disagree. That is the feature: today the SLA tab and the SLA report reach
 * "Elapsed Time" through different business-hour lookups and customers see two numbers.
 *
 * Rules (mirroring the backend's SlaAppliedHistory model):
 *   a minute counts toward a target only when it is inside business hours AND the clock is not paused.
 *   Business hours: Mon–Fri 09:00–18:00. Pausing is driven by status (Status.slaOff); a UC ignores it.
 * Demo timeline is fixed in Sep 2026 so the numbers never drift with the real clock. */

const MIN = 60_000;
export const D = (d: number, h: number, m: number) => new Date(2026, 8, d, h, m);
const ME = 'Sarah Johnson';   // the signed-in technician in the demo

export interface Pause { from: Date; to: Date | null; why: string; by: string }
export interface ManualDue { due: Date; by: string; at: Date; reason: string }
export interface Excuse { by: string; at: Date; reason: string }
export type Edge = 'nosla' | 'archived' | 'error';
export interface Scenario {
  key: ScenarioKey; label: string; now: Date; pauses: Pause[];
  resolved?: Date; firstReply?: Date; noReply?: boolean; manual?: Partial<Record<ClockId, ManualDue>>; excuses?: Partial<Record<ClockId, Excuse>>; status: string;
  edge?: Edge; extra?: ClockDef[]; dueBy?: Date; deletedOn?: Date;
}
export type ScenarioKey = 'ok' | 'overdue' | 'late' | 'risk' | 'paused' | 'breached' | 'met' | 'manual' | 'excused' | 'nosla' | 'archived' | 'error' | 'many';

/* Business hours come from the technician group (SlaPolicyCalculatorServiceImpl.calculateSLA:
 * "identify bizhour from technician group"); a calendar-hours policy counts 24x7 (SlaOperationalHourType.CALENDAR_HOURS). */
export interface Hours { name: string; line: string; calendar?: boolean }
const WEEKDAYS = 'Mon–Fri 9 AM–6 PM IST';
const NETWORK_HOURS: Hours = { name: 'Network Team hours', line: WEEKDAYS };
const DESK_HOURS: Hours = { name: 'Service Desk hours', line: WEEKDAYS };
const ALL_HOURS: Hours = { name: 'Calendar hours', line: '24 x 7', calendar: true };
const wfc = (from: Date, to: Date | null, why = 'Waiting on requester'): Pause => ({ from, to, why, by: ME });

export const PAUSE_REASONS = ['Waiting on requester', 'Waiting on vendor', 'Scheduled for later', 'Waiting on a change'];
export const PAUSING_STATUSES = ['Pending', 'On Hold'];

export type ClockId = 'first' | 'resolution' | 'ola-desk' | 'ola-network' | 'uc' | 'ola-db' | 'ola-sec';
export interface ClockDef {
  id: ClockId; kind: 'SLA' | 'OLA' | 'UC'; name: string; short: string; start: Date; target: number; hours: Hours;
  /** Penalty rule (SlaPenalty: penaltyPerUnit per started unit over target). */
  penaltyPerHour?: number;
  stop: (s: Scenario) => Date | undefined; stopWhy: string; startWhy: string; startedWhen: string;
  /** What stopping this clock is called on screen: Replied, Resolved, Handed over, Restored. */
  doneVerb: string;
  policy: string; rule: [string, string, string][];
  /** Escalation levels: `at` is the fraction of the target used when the level fires (1 = at breach). */
  escalations: { level: number; at: number; action: string }[];
  /** Pauses that belong to this clock alone (a team that is waiting on its own vendor). */
  pauses?: Pause[];
  /** The SLA this one replaced when a condition changed. The old target is canceled and kept for visibility;
   *  the new one is recalculated from request creation (SlaPolicyCalculatorServiceImpl.calculateSLA uses
   *  ticket createdTime + totalSlaPauseTime), so time already spent counts against the new target. */
  replaced?: { policy: string; target: string; at: Date; change: string; by: string };
}
const P2_RULE: [string, string, string][] = [['Priority', 'is', 'High'], ['Category', 'is', 'Network']];
const UC_RESTORED = D(30, 13, 25);
const MANAGER = 'Priya Mehta (Network Team manager)';
export const CLOCKS: ClockDef[] = [
  { id: 'first', kind: 'SLA', name: 'First response', short: 'Response', start: D(29, 16, 10), target: 30, hours: NETWORK_HOURS, stop: s => (s.noReply ? undefined : s.firstReply ?? D(29, 16, 24)),
    stopWhy: 'first reply sent to the requester', doneVerb: 'Replied', startWhy: 'Request created', startedWhen: 'When the request was created', policy: 'P2 High – Response SLA', rule: P2_RULE, escalations: [] },
  { id: 'resolution', kind: 'SLA', name: 'Resolution', short: 'Resolution', start: D(29, 16, 10), target: 480, hours: NETWORK_HOURS, stop: s => s.resolved,
    stopWhy: 'request resolved', doneVerb: 'Resolved', startWhy: 'Request created', startedWhen: 'When the request was created', policy: 'P2 High – Resolution SLA', rule: P2_RULE, penaltyPerHour: 50,
    escalations: [{ level: 1, at: 0.75, action: `email to ${MANAGER}` }, { level: 2, at: 1, action: 'reassigned to Priya Mehta, SMS to technician' }],
    replaced: { policy: 'P3 Standard – Resolution SLA', target: '3 days', at: D(29, 17, 2), change: 'priority changed from Medium to High', by: ME } },
  /* A policy can carry one OLA per technician group, in order (SlaPolicy.olaConfigSet, OlaConfig.groupIds / olaOrder). */
  { id: 'ola-desk', kind: 'OLA', name: 'Service Desk · OLA', short: 'OLA 1', start: D(29, 16, 10), target: 90, hours: DESK_HOURS, stop: () => D(29, 17, 20),
    stopWhy: 'request moved to Network Team', doneVerb: 'Handed over', startWhy: 'Assigned to Service Desk', startedWhen: 'When the request was assigned to Service Desk',
    policy: 'P2 High – OLA 1 (Service Desk, 1h 30m)', rule: [['Technician group', 'is', 'Service Desk']], escalations: [] },
  { id: 'ola-network', kind: 'OLA', name: 'Network Team · OLA', short: 'OLA 2', start: D(29, 17, 20), target: 360, hours: NETWORK_HOURS, stop: s => s.resolved,
    stopWhy: 'request resolved', doneVerb: 'Resolved', startWhy: 'Assigned to Network Team', startedWhen: 'When the request was assigned to Network Team',
    policy: 'P2 High – OLA 2 (Network Team, 6h)', rule: [['Technician group', 'is', 'Network Team']], escalations: [{ level: 1, at: 0.75, action: 'email to the Network Team' }] },
  /* Underpinning contract with the vendor — shown only when one applies (SlaHistoryType.UC). 24x7 contract.
   * It ignores Pending / On Hold: a UC has its own "Run UC" flag and in this demo it stays on. */
  { id: 'uc', kind: 'UC', name: 'Airtel · UC', short: 'UC', start: D(30, 9, 40), target: 240, hours: ALL_HOURS,
    stop: s => (s.resolved && s.resolved < UC_RESTORED ? s.resolved : UC_RESTORED),
    stopWhy: 'vendor restored the link', doneVerb: 'Restored', startWhy: 'Vendor set to Airtel Business', startedWhen: 'When the vendor was set to Airtel Business',
    policy: 'Airtel Business – Link restore UC (4h, 24 x 7)', rule: [['Vendor', 'is', 'Airtel Business']], escalations: [] },
];
/** Two more team OLAs, only in the `many` scenario (stress test for a long card). Each waits on its own vendor. */
const EXTRA_OLAS: ClockDef[] = [
  { id: 'ola-db', kind: 'OLA', name: 'Database Team · OLA', short: 'OLA 3', start: D(30, 9, 15), target: 240, hours: { name: 'Database Team hours', line: WEEKDAYS }, stop: s => s.resolved,
    stopWhy: 'request resolved', doneVerb: 'Resolved', startWhy: 'Assigned to Database Team', startedWhen: 'When the request was assigned to Database Team',
    policy: 'P2 High – OLA 3 (Database Team, 4h)', rule: [['Technician group', 'is', 'Database Team']], escalations: [], pauses: [wfc(D(30, 10, 45), null, 'Waiting on vendor')] },
  { id: 'ola-sec', kind: 'OLA', name: 'Security Team · OLA', short: 'OLA 4', start: D(30, 9, 25), target: 240, hours: { name: 'Security Team hours', line: WEEKDAYS }, stop: s => s.resolved,
    stopWhy: 'request resolved', doneVerb: 'Resolved', startWhy: 'Assigned to Security Team', startedWhen: 'When the request was assigned to Security Team',
    policy: 'P2 High – OLA 4 (Security Team, 4h)', rule: [['Technician group', 'is', 'Security Team']], escalations: [], pauses: [wfc(D(30, 13, 10), null)] },
];

const RISK_NOW = D(30, 15, 5);
export const SCENARIOS: Record<ScenarioKey, Scenario> = {
  ok: { key: 'ok', label: 'On track', now: D(30, 10, 15), pauses: [], status: 'In Progress' },
  /* The Neysa case, in two steps. The response was due 4:40 PM.
     1) No reply yet at 5:10 PM: it must already read Breached (today's product waits until resolve). */
  overdue: { key: 'overdue', label: 'Reply overdue', now: D(29, 17, 10), pauses: [], noReply: true, status: 'In Progress' },
  /* 2) Reply sent at 5:15 PM, after due: still Breached, never Met. */
  late: { key: 'late', label: 'Late reply', now: D(29, 17, 30), pauses: [], firstReply: D(29, 17, 15), status: 'In Progress' },
  risk: { key: 'risk', label: 'At risk', now: RISK_NOW, pauses: [wfc(D(30, 10, 30), D(30, 11, 40))], status: 'In Progress' },
  paused: { key: 'paused', label: 'Paused', now: RISK_NOW, pauses: [wfc(D(30, 10, 30), D(30, 11, 40)), wfc(D(30, 14, 40), null, 'Waiting on vendor')], status: 'Pending' },
  breached: { key: 'breached', label: 'Breached', now: D(30, 17, 5), pauses: [wfc(D(30, 10, 30), D(30, 11, 40))], status: 'In Progress' },
  met: { key: 'met', label: 'Resolved', now: RISK_NOW, pauses: [wfc(D(30, 10, 30), D(30, 11, 40))], resolved: D(30, 14, 12), status: 'Resolved' },
  manual: {
    key: 'manual', label: 'Due set by hand', now: RISK_NOW, pauses: [wfc(D(30, 10, 30), D(30, 11, 40))], status: 'In Progress',
    manual: { resolution: { due: D(30, 17, 30), by: ME, at: D(30, 14, 50), reason: 'Customer agreed on the 2:45 PM call to a 5:30 PM fix window.' } },
  },
  excused: {
    key: 'excused', label: 'Breach excused', now: D(30, 17, 5), pauses: [wfc(D(30, 10, 30), D(30, 11, 40))], status: 'In Progress',
    excuses: { resolution: { by: ME, at: D(30, 16, 55), reason: 'Airtel circuit outage, agreed with requester' } },
  },
  /* Edge cases: the engine only carries the data and flags, the card renders them. */
  nosla: { key: 'nosla', label: 'No SLA', now: RISK_NOW, pauses: [], status: 'In Progress', edge: 'nosla', dueBy: D(30, 18, 0) },
  archived: { key: 'archived', label: 'Policy deleted', now: RISK_NOW, pauses: [wfc(D(30, 10, 30), D(30, 11, 40))], status: 'In Progress', edge: 'archived', deletedOn: D(30, 13, 0) },
  error: { key: 'error', label: 'Failed to load', now: RISK_NOW, pauses: [], status: 'In Progress', edge: 'error' },
  many: { key: 'many', label: 'Many clocks', now: RISK_NOW, pauses: [wfc(D(30, 10, 30), D(30, 11, 40))], status: 'In Progress', extra: EXTRA_OLAS },
};

const isWork = (t: Date) => { const w = t.getDay(), h = t.getHours(); return w >= 1 && w <= 5 && h >= 9 && h < 18; };
const bizOf = (def: ClockDef) => (def.hours.calendar ? () => true : isWork);
const inPause = (t: Date, ps: Pause[]) => ps.some(p => t >= p.from && t < (p.to ?? new Date(8.64e15)));
/** A UC ignores the request's pauses; every other clock also carries its own. */
const pausesOf = (def: ClockDef, s: Scenario) => (def.kind === 'UC' ? [] : [...s.pauses, ...(def.pauses ?? [])]);
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

/** `missed` = stopped after its due time (shown as Breached). */
export type ClockState = 'ok' | 'risk' | 'paused' | 'breached' | 'met' | 'missed' | 'excused';
export interface ClockResult {
  def: ClockDef; state: ClockState; stop?: Date; end: Date;
  calendar: number; outside: number; paused: number; counted: number;
  left: number; due: Date | null; policyDue: Date; firstDue: Date; early: number;
  /** Business minutes spent in pauses that have ENDED — only these have moved the due time. */
  pausedClosed: number;
  pausedNow?: Pause; manual?: ManualDue; excuse?: Excuse;
  penalty: number;
  /** Minutes the clock is measured against: the target, or counted-at-due when the due was set by hand. */
  budget: number;
  /** counted / budget, uncapped (1.2 = 20% over). */
  pct: number;
  /** Highest escalation level reached, 0 if none. */
  escLevel: number;
  /** Ran past its due time (running or finished late), even if it was later excused. */
  breached: boolean;
}

export function calc(def: ClockDef, s: Scenario): ClockResult {
  const planned = def.stop(s), stop = planned && planned <= s.now ? planned : undefined;  // a stop that hasn't happened yet doesn't count
  const end = stop ?? s.now, ps = pausesOf(def, s);
  const pausedNow = stop ? undefined : ps.find(p => !p.to && p.from <= end);
  const isBiz = bizOf(def);
  const work = (a: Date, b: Date) => count(a, b, t => isBiz(t) && !inPause(t, ps));
  const biz = count(def.start, end, isBiz);
  const counted = work(def.start, end);
  const calendar = Math.round((end.getTime() - def.start.getTime()) / MIN);
  const firstDue = walk(def.start, def.target, isBiz);
  const policyDue = walk(def.start, def.target, t => isBiz(t) && !inPause(t, ps.filter(p => p.to)));
  let due: Date | null = pausedNow && policyDue > end ? null : policyDue; // paused short of target: due unknown until restart
  const manual = s.manual?.[def.id], excuse = s.excuses?.[def.id];
  let left = def.target - counted;
  if (manual) {
    due = manual.due;
    left = end < due ? count(end, due, isBiz) : -work(due, end);
  }
  let state: ClockState;
  if (stop) state = (manual ? stop <= manual.due : counted <= def.target) ? 'met' : 'missed';
  else if (left <= 0) state = 'breached';
  else if (pausedNow) state = 'paused';
  else state = left < def.target * 0.25 ? 'risk' : 'ok'; // at risk = under a quarter of the target left
  const early = state === 'met' && due && stop ? count(stop, due, t => isBiz(t) && !inPause(t, ps)) : 0;
  const breached = state === 'breached' || state === 'missed';
  if (excuse) state = 'excused';
  const pausedClosed = count(def.start, end, t => isBiz(t) && inPause(t, ps.filter(p => p.to)));
  // a hand-set due is penalised for the business minutes counted after it; an excused clock owes nothing
  const over = manual ? (end > manual.due ? work(manual.due, end) : 0) : Math.max(0, counted - def.target);
  const penalty = def.penaltyPerHour && !excuse && over > 0 ? Math.ceil(over / 60) * def.penaltyPerHour : 0;
  const budget = manual ? counted + left : def.target;
  const escLevel = def.escalations.reduce((m, e) => (counted >= Math.ceil(e.at * budget) ? Math.max(m, e.level) : m), 0);
  return { penalty, pausedClosed, def, state, stop, end, calendar, outside: calendar - biz, paused: biz - counted, counted, left, due, policyDue, firstDue, early, pausedNow, manual, excuse,
    budget, pct: budget > 0 ? counted / budget : 0, escLevel, breached };
}

export type SegKind = 'run' | 'off' | 'pause' | 'over';
export function segments(r: ClockResult, s: Scenario): [SegKind, number][] {
  const out: [SegKind, number][] = [], ps = pausesOf(r.def, s);
  const dueT = r.due && r.state !== 'met' ? r.due.getTime() : Infinity;
  let cur: SegKind | null = null, n = 0;
  for (let t = r.def.start.getTime(); t < r.end.getTime(); t += MIN) {
    const d = new Date(t);
    const k: SegKind = !r.def.hours.calendar && !isWork(d) ? 'off' : inPause(d, ps) ? 'pause' : t >= dueT ? 'over' : 'run';
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
export const fmtTime = (d: Date) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
export const fmtDay = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
export const fmtWhen = (d: Date) => `${fmtDay(d)}, ${fmtTime(d)}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayNo = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5;
/** "today 4:20 PM IST", "tomorrow 9:30 AM IST", "Wed 30 Sep, 4:20 PM IST" — relative to the scenario's now. */
export function fmtDue(d: Date, now: Date) {
  const diff = dayNo(d) - dayNo(now), t = `${fmtTime(d)} IST`;
  return diff === 0 ? `today ${t}` : diff === 1 ? `tomorrow ${t}` : `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${t}`;
}
const fmtStamp = (d: Date) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${fmtTime(d)}`;

export const STATE_LABEL: Record<ClockState, string> = { ok: 'On track', risk: 'At risk', paused: 'Paused', breached: 'Breached', met: 'Met', missed: 'Breached', excused: 'Excused' };  // a clock that stopped after its due time is Breached, not Met
/* Tones reuse the ticket page's own SLA pill palette (green / amber / red) plus a neutral grey for paused. */
export const STATE_TONE: Record<ClockState, { bg: string; text: string; bar: string }> = {
  ok: { bg: '#E8F5E9', text: '#27AE60', bar: '#27AE60' },
  met: { bg: '#E8F5E9', text: '#27AE60', bar: '#27AE60' },
  risk: { bg: '#FFF3E0', text: '#F39C12', bar: '#F39C12' },
  breached: { bg: '#FFEBEE', text: '#E74C3C', bar: '#E74C3C' },
  missed: { bg: '#FFEBEE', text: '#E74C3C', bar: '#E74C3C' },
  paused: { bg: '#EEF1F6', text: '#5B6B86', bar: '#9AA8C0' },
  excused: { bg: '#F1F5F9', text: '#64748B', bar: '#94A3B8' },
};

/** Short value for pills: "1h 15m left", "45m over", "Paused", "Met". */
export function shortValue(r: ClockResult) {
  switch (r.state) {
    case 'ok': case 'risk': return `${fmtDur(r.left)} left`;
    case 'paused': return 'Paused';
    case 'breached': return `${fmtDur(-r.left)} over`;
    case 'met': return fmtDur(r.counted);
    case 'missed': return `${fmtDur(r.counted - r.def.target)} over`;
    case 'excused': return 'Excused';
  }
}

/* tiny shared store so every surface reads the same scenario. All edits live on one scenario copy. */
const fresh = (k: ScenarioKey): Scenario => { const s = SCENARIOS[k]; return { ...s, pauses: [...s.pauses], manual: { ...s.manual }, excuses: { ...s.excuses } }; };
let cur: Scenario = fresh('risk');
let version = 0;
const subs = new Set<() => void>();
const put = (s: Scenario) => { cur = s; version++; subs.forEach(f => f()); };
const patch = (p: Partial<Scenario>) => put({ ...cur, ...p });
/** Switching scenario drops every edit, then seeds manual / excuse from the scenario's own so revert and remove work on them. */
export const setScenario = (k: ScenarioKey) => put(fresh(k));
/** The existing "edit SLA date" pencil. Same rule as the backend's dueTimeManuallyUpdated: the hand-set time wins. */
export const setManualDue = (id: ClockId, due: Date, reason: string) => patch({ manual: { ...cur.manual, [id]: { due, by: ME, at: cur.now, reason } } });
export const revertManualDue = (id: ClockId) => { const manual = { ...cur.manual }; delete manual[id]; patch({ manual }); };
export const excuse = (id: ClockId, reason: string) => patch({ excuses: { ...cur.excuses, [id]: { by: ME, at: cur.now, reason } } });
export const removeExcuse = (id: ClockId) => { const excuses = { ...cur.excuses }; delete excuses[id]; patch({ excuses }); };
/** A pausing status opens a pause (why = the reason, or the status itself); any other status closes it. Resolved / Closed also stop the clocks. */
export function setStatus(label: string, reason?: string) {
  const now = cur.now, open = cur.pauses.some(p => !p.to);
  if (PAUSING_STATUSES.includes(label)) {
    patch({ status: label, pauses: open || cur.resolved ? cur.pauses : [...cur.pauses, { from: now, to: null, why: reason || label, by: ME }] });
  } else {
    const done = label === 'Resolved' || label === 'Closed';
    patch({ status: label, pauses: cur.pauses.map(p => (p.to ? p : { ...p, to: now })), resolved: done ? cur.resolved ?? now : undefined });
  }
}

/** Clocks run in a fixed order: First response, Resolution, OLAs (by start), UC. */
const rank = (c: ClockDef) => (c.kind === 'UC' ? 3 : c.kind === 'OLA' ? 2 : c.id === 'resolution' ? 1 : 0);
export function useSla() {
  useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => version);
  const s = cur, none = s.edge === 'nosla' || s.edge === 'error';
  // a clock shows only once it applies (e.g. the UC starts when the vendor is set)
  const defs = none ? [] : [...CLOCKS, ...(s.extra ?? [])].filter(c => c.start <= s.now).sort((a, b) => rank(a) - rank(b) || a.start.getTime() - b.start.getTime());
  return { scenario: s, clocks: defs.map(c => calc(c, s)), previous: none ? [] : previousClocks(s), status: s.status, edge: s.edge ?? null };
}

/** The one demo request the new SLA experience runs on. */
export const SLA_DEMO_ID = 'INC-32';
/** Non-hook read for list cells (the grid pill for the demo request). */
export function slaSnapshot() {
  return { scenario: cur, resolution: calc(CLOCKS[1], cur) };
}

/** The most urgent clock for the header pill: running ones first (breached > risk > on track > paused), then finished (breached late > excused > met).
 *  Among equals the one with less time left wins, then the earlier due. */
const URGENCY: ClockState[] = ['breached', 'risk', 'ok', 'paused', 'missed', 'excused', 'met'];
export function headerSummary(clocks: ClockResult[]): { clock: ClockResult | null; state: ClockState | 'none' } {
  const due = (r: ClockResult) => r.due?.getTime() ?? 9e15;
  const clock = [...clocks].sort((a, b) => URGENCY.indexOf(a.state) - URGENCY.indexOf(b.state) || a.left - b.left || due(a) - due(b))[0] ?? null;
  return clock ? { clock, state: clock.state } : { clock: null, state: 'none' };
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
  policy: 'P3 Standard', appliedAt: D(29, 16, 10), canceledAt: D(29, 17, 2), by: ME,
  change: 'Priority changed from Medium to High', rule: PREV_RULE, penaltyRule: 'No penalty on this SLA',
  clocks: [
    { id: 'first', kind: 'SLA', name: 'First response', short: 'Response', start: D(29, 16, 10), target: 60, hours: NETWORK_HOURS,
      stop: s => (s.noReply ? undefined : s.firstReply ?? D(29, 16, 24)), stopWhy: 'first reply sent to the requester', doneVerb: 'Replied', startWhy: 'Request created', startedWhen: 'When the request was created',
      policy: 'P3 Standard – Response SLA', rule: PREV_RULE, escalations: [] },
    { id: 'resolution', kind: 'SLA', name: 'Resolution', short: 'Resolution', start: D(29, 16, 10), target: 27 * 60, hours: NETWORK_HOURS,
      stop: () => D(29, 17, 2), stopWhy: 'SLA canceled', doneVerb: 'Canceled', startWhy: 'Request created', startedWhen: 'When the request was created',
      policy: 'P3 Standard – Resolution SLA', rule: PREV_RULE, escalations: [] },
  ] as ClockDef[],
};
/** The earlier SLA's clocks, frozen at the moment it was canceled (no pauses had happened yet). */
export const previousClocks = (s?: Scenario) => PREVIOUS.clocks.map(c => calc(c, { ...SCENARIOS.ok, now: PREVIOUS.canceledAt, pauses: [], manual: undefined, excuses: undefined, resolved: undefined,
  // a reply after the cancel time belongs to the new SLA, not this one
  noReply: !!s?.noReply || (!!s?.firstReply && s.firstReply > PREVIOUS.canceledAt), firstReply: s?.firstReply }));

/** How a stopped clock finished, in plain words: "Replied 4:52 PM, 12m late". */
export function finishedLine(r: ClockResult, long = false) {
  if (!r.stop) return '';
  const at = long ? fmtWhen(r.stop) : fmtTime(r.stop);
  return r.breached
    ? `${r.def.doneVerb} ${at}, ${fmtDur(r.counted - r.def.target)} late`
    : `${r.def.doneVerb} ${at}`;
}

/* History */
export interface SlaEvent { at: Date; kind: 'attached' | 'paused' | 'resumed' | 'escalated' | 'overridden' | 'breached' | 'met' | 'handed-over' | 'excused' | 'canceled'; text: string; by: string }
const lower = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
/** What happened on one clock, oldest first, up to the scenario's now. */
export function events(r: ClockResult, s: Scenario): SlaEvent[] {
  const { def } = r, ps = pausesOf(def, s), isBiz = bizOf(def), out: SlaEvent[] = [];
  const add = (at: Date, kind: SlaEvent['kind'], text: string, by = 'SLA engine') => { if (at <= s.now) out.push({ at, kind, text, by }); };
  add(def.start, 'attached', `Attached. ${def.startWhy}.`);
  for (const p of ps) if (p.from >= def.start && p.from <= r.end) {
    add(p.from, 'paused', `Paused, ${lower(p.why)}`, p.by);
    if (p.to && p.to <= r.end) add(p.to, 'resumed', `Resumed after ${fmtDur(count(p.from, p.to, isBiz))}`, p.by);
  }
  if (r.manual) add(r.manual.at, 'overridden', `Due time changed to ${fmtTime(r.manual.due)}.${r.manual.reason ? ` Reason: ${r.manual.reason}` : ''}`, r.manual.by);
  if (r.breached && r.due) add(r.due, 'breached', 'Breached');
  for (const e of def.escalations) {
    const need = Math.ceil(e.at * r.budget);
    if (r.counted >= need) add(walk(def.start, need, t => isBiz(t) && !inPause(t, ps)), 'escalated', `Level ${e.level} escalation: ${e.action}`);
  }
  if (r.stop) {
    if (r.breached) add(r.stop, 'breached', finishedLine(r));
    else if (def.doneVerb === 'Handed over') add(r.stop, 'handed-over', `Handed over to ${def.stopWhy.replace(/^request moved to /, '')}`, ME);
    else add(r.stop, 'met', `Met in ${fmtDur(r.counted)}`);
  }
  if (r.excuse) add(r.excuse.at, 'excused', `Excused. Reason: ${r.excuse.reason}`, r.excuse.by);
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Who held the request while this clock ran. */
const ASSIGNED = [
  { group: 'Service Desk', who: 'Darsh Patel', from: D(29, 16, 10), to: D(29, 17, 20) as Date | null },
  { group: 'Network Team', who: ME, from: D(29, 17, 20), to: null as Date | null },
];
/** The assignment segments clipped to the clock's window, with the time counted and paused in each. `to: null` = still with them. */
export function usage(r: ClockResult, s: Scenario) {
  const { def } = r, ps = pausesOf(def, s), isBiz = bizOf(def);
  return ASSIGNED.flatMap(a => {
    const from = a.from > def.start ? a.from : def.start;
    if (from >= r.end) return [];
    const to = a.to && a.to <= r.end ? a.to : r.stop ?? null;
    const upTo = to ?? r.end;
    return [{ group: a.group, who: a.who, from, to, counted: count(from, upTo, t => isBiz(t) && !inPause(t, ps)), paused: count(from, upTo, t => isBiz(t) && inPause(t, ps)) }];
  });
}

/** Why this target applies to this request, as plain sentences. */
export function whyThis(r: ClockResult) {
  const { def } = r;
  return {
    policy: def.policy,
    matched: def.rule.map(([f, , v]) => `${f} is ${v}`).join(' and '),
    target: `${fmtDur(def.target)} of ${def.hours.calendar ? 'calendar time' : 'business time'}`,
    hours: def.hours.calendar ? def.hours.line : `${def.hours.name}, ${def.hours.line}`,
    started: `${def.startedWhen}, ${fmtStamp(def.start)}`,
  };
}
