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
export const ME = 'Sarah Johnson';   // the signed-in technician in the demo

/** `status` is the request status that stopped the clock (whatever the admin named it); `why` is the optional reason given. */
export interface Pause { from: Date; to: Date | null; why: string; status: string; by: string }
export interface ManualDue { due: Date; by: string; at: Date; reason: string }
export interface Excuse { by: string; at: Date; reason: string }
export type Edge = 'nosla' | 'archived' | 'error';
export interface Scenario {
  key: ScenarioKey; label: string; now: Date; pauses: Pause[];
  resolved?: Date; firstReply?: Date; noReply?: boolean; manual?: Partial<Record<ClockId, ManualDue>>; excuses?: Partial<Record<ClockId, Excuse>>; status: string;
  edge?: Edge; extra?: ClockDef[]; dueBy?: Date; deletedOn?: Date;
  /** Every status change, oldest first. Seeded from the story by the store, appended by setStatus. */
  log?: StatusChange[];
}
export interface StatusChange { at: Date; to: string; by: string }
export type ScenarioKey = 'ok' | 'overdue' | 'late' | 'risk' | 'paused' | 'breached' | 'met' | 'manual' | 'excused' | 'nosla' | 'archived' | 'error' | 'many';

/* Business hours come from the technician group (SlaPolicyCalculatorServiceImpl.calculateSLA:
 * "identify bizhour from technician group"); a calendar-hours policy counts 24x7 (SlaOperationalHourType.CALENDAR_HOURS). */
export interface Hours { name: string; line: string; calendar?: boolean }
const WEEKDAYS = 'Mon–Fri 9 AM–6 PM IST';
const NETWORK_HOURS: Hours = { name: 'Network Team hours', line: WEEKDAYS };
const DESK_HOURS: Hours = { name: 'Service Desk hours', line: WEEKDAYS };
const ALL_HOURS: Hours = { name: 'Calendar hours', line: '24 x 7', calendar: true };
const wfc = (from: Date, to: Date | null, why = 'Waiting on requester'): Pause => ({ from, to, why, status: 'Pending', by: ME });

export const PAUSE_REASONS = ['Waiting on requester', 'Waiting on vendor', 'Scheduled for later', 'Waiting on a change'];
export const PAUSING_STATUSES = ['Pending', 'On Hold'];

export type ClockId = 'first' | 'resolution' | 'ola-desk' | 'ola-network' | 'uc' | 'ola-db' | 'ola-sec';
export interface ClockDef {
  id: ClockId; kind: 'SLA' | 'OLA' | 'UC'; name: string; start: Date; target: number; hours: Hours;
  /** Penalty rule (SlaPenalty: penaltyPerUnit per started unit over target). */
  penaltyPerHour?: number;
  stop: (s: Scenario) => Date | undefined; stopWhy: string; startedWhen: string;
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
  { id: 'first', kind: 'SLA', name: 'First response', start: D(29, 16, 10), target: 30, hours: NETWORK_HOURS, stop: s => (s.noReply ? undefined : s.firstReply ?? D(29, 16, 24)),
    stopWhy: 'first reply sent to the requester', doneVerb: 'Replied', startedWhen: 'When the request was created', policy: 'P2 High – Response SLA', rule: P2_RULE, escalations: [] },
  { id: 'resolution', kind: 'SLA', name: 'Resolution', start: D(29, 16, 10), target: 480, hours: NETWORK_HOURS, stop: s => s.resolved,
    stopWhy: 'request resolved', doneVerb: 'Resolved', startedWhen: 'When the request was created', policy: 'P2 High – Resolution SLA', rule: P2_RULE, penaltyPerHour: 50,
    escalations: [{ level: 1, at: 0.75, action: `email to ${MANAGER}` }, { level: 2, at: 1, action: 'reassigned to Priya Mehta, SMS to technician' }],
    replaced: { policy: 'P3 Standard – Resolution SLA', target: '3 days', at: D(29, 17, 2), change: 'priority changed from Medium to High', by: ME } },
  /* A policy can carry one OLA per technician group, in order (SlaPolicy.olaConfigSet, OlaConfig.groupIds / olaOrder). */
  { id: 'ola-desk', kind: 'OLA', name: 'Service Desk · OLA', start: D(29, 16, 10), target: 90, hours: DESK_HOURS, stop: () => D(29, 17, 20),
    stopWhy: 'request moved to Network Team', doneVerb: 'Handed over', startedWhen: 'When the request was assigned to Service Desk',
    policy: 'P2 High – OLA 1 (Service Desk, 1h 30m)', rule: [['Technician group', 'is', 'Service Desk']], escalations: [] },
  { id: 'ola-network', kind: 'OLA', name: 'Network Team · OLA', start: D(29, 17, 20), target: 360, hours: NETWORK_HOURS, stop: s => s.resolved,
    stopWhy: 'request resolved', doneVerb: 'Resolved', startedWhen: 'When the request was assigned to Network Team',
    policy: 'P2 High – OLA 2 (Network Team, 6h)', rule: [['Technician group', 'is', 'Network Team']], penaltyPerHour: 20, escalations: [{ level: 1, at: 0.75, action: 'email to the Network Team' }] },
  /* Underpinning contract with the vendor — shown only when one applies (SlaHistoryType.UC). 24x7 contract.
   * It ignores Pending / On Hold: a UC has its own "Run UC" flag and in this demo it stays on. */
  { id: 'uc', kind: 'UC', name: 'Airtel · UC', start: D(30, 9, 40), target: 240, hours: ALL_HOURS,
    stop: s => (s.resolved && s.resolved < UC_RESTORED ? s.resolved : UC_RESTORED),
    stopWhy: 'vendor restored the link', doneVerb: 'Restored', startedWhen: 'When the vendor was set to Airtel Business',
    policy: 'Airtel Business – Link restore UC (4h, 24 x 7)', rule: [['Vendor', 'is', 'Airtel Business']], penaltyPerHour: 100, escalations: [] },
];
/** Two more team OLAs, only in the `many` scenario (stress test for a long card). Each waits on its own vendor. */
const EXTRA_OLAS: ClockDef[] = [
  { id: 'ola-db', kind: 'OLA', name: 'Database Team · OLA', start: D(30, 9, 15), target: 240, hours: { name: 'Database Team hours', line: WEEKDAYS }, stop: s => s.resolved,
    stopWhy: 'request resolved', doneVerb: 'Resolved', startedWhen: 'When the request was assigned to Database Team',
    policy: 'P2 High – OLA 3 (Database Team, 4h)', rule: [['Technician group', 'is', 'Database Team']], escalations: [], pauses: [wfc(D(30, 10, 45), null, 'Waiting on vendor')] },
  { id: 'ola-sec', kind: 'OLA', name: 'Security Team · OLA', start: D(30, 9, 25), target: 240, hours: { name: 'Security Team hours', line: WEEKDAYS }, stop: s => s.resolved,
    stopWhy: 'request resolved', doneVerb: 'Resolved', startedWhen: 'When the request was assigned to Security Team',
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
  paused: number; counted: number;
  left: number; due: Date | null; policyDue: Date; firstDue: Date;
  /** Business minutes spent in pauses that have ENDED — only these have moved the due time. */
  pausedClosed: number;
  pausedNow?: Pause; manual?: ManualDue; excuse?: Excuse;
  penalty: number;
  /** Minutes the clock is measured against: the target, or counted-at-due when the due was set by hand. */
  budget: number;
  /** counted / budget, uncapped (1.2 = 20% over). */
  pct: number;
  /** Escalations sent, oldest first. A level reached before a due time was set by hand is kept. */
  escalated: { level: number; at: Date; action: string }[];
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
  const firstDue = walk(def.start, def.target, isBiz);
  const policyDue = walk(def.start, def.target, t => isBiz(t) && !inPause(t, ps.filter(p => p.to)));
  let due: Date | null = pausedNow && policyDue > end ? null : policyDue; // paused short of target: due unknown until restart
  const manual = s.manual?.[def.id], exc = s.excuses?.[def.id];
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
  const breached = state === 'breached' || state === 'missed';
  if (exc) state = 'excused';
  const pausedClosed = count(def.start, end, t => isBiz(t) && inPause(t, ps.filter(p => p.to)));
  const budget = manual ? counted + left : def.target;
  // a hand-set due is penalised for the business minutes counted after it; an excused clock owes nothing
  const over = Math.max(0, counted - budget);
  const penalty = def.penaltyPerHour && !exc && over > 0 ? Math.ceil(over / 60) * def.penaltyPerHour : 0;
  // A level already sent under the policy target stays sent when the due is later set by hand; later levels use the new budget.
  const reach = (mins: number) => walk(def.start, mins, t => isBiz(t) && !inPause(t, ps));
  const countedAtManual = manual ? work(def.start, manual.at < end ? manual.at : end) : 0;
  const escalated = def.escalations.flatMap(e => {
    const pre = Math.ceil(e.at * def.target), post = Math.ceil(e.at * budget);
    if (manual && countedAtManual >= pre) return [{ level: e.level, at: reach(pre), action: e.action }];
    if (counted < post) return [];
    // a level the hand-set due puts in the past is sent when the due is set, never back-dated
    const at = reach(post);
    return [{ level: e.level, at: manual && at < manual.at ? manual.at : at, action: e.action }];
  });
  const escLevel = escalated.reduce((m, e) => Math.max(m, e.level), 0);
  return { penalty, pausedClosed, def, state, stop, end, paused: biz - counted, counted, left, due, policyDue, firstDue, pausedNow, manual, excuse: exc,
    budget, pct: budget > 0 ? counted / budget : 0, escalated, escLevel, breached };
}

/* formatting */
export const fmtDur = (m: number) => {
  m = Math.round(Math.abs(m));
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h}h ${String(r).padStart(2, '0')}m` : `${h}h`) : `${r}m`;
};
export const fmtTime = (d: Date) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayNo = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5;
/** "today 4:20 PM IST", "tomorrow 9:30 AM IST", "Wed 30 Sep, 4:20 PM IST" — relative to the scenario's now. */
export function fmtDue(d: Date, now: Date) {
  const diff = dayNo(d) - dayNo(now), t = `${fmtTime(d)} IST`;
  return diff === 0 ? `today ${t}` : diff === 1 ? `tomorrow ${t}` : `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${t}`;
}
const fmtStamp = (d: Date) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${fmtTime(d)}`;

/** SLA / OLA / UC marks: one blue ramp, darkest for the customer's promise, never a state colour.
 *  `text` is the label colour (the UC shade is too light for 11px text). */
export const KIND_COLOUR: Record<ClockDef['kind'], { line: string; tint: string; text: string }> = {
  SLA: { line: '#1E5AA8', tint: '#EEF4FB', text: '#1E5AA8' },
  OLA: { line: '#4A90D9', tint: '#F1F7FD', text: '#2F78C4' },
  UC: { line: '#8AB8E6', tint: '#F5F9FE', text: '#4F84B8' },
};
export const STATE_LABEL: Record<ClockState, string> = { ok: 'On track', risk: 'At risk', paused: 'Paused', breached: 'Breached', met: 'Met', missed: 'Breached', excused: 'Excused' };  // a clock that stopped after its due time is Breached, not Met
/* Tones reuse the ticket page's own SLA pill palette (green / amber / red) plus a neutral grey for paused. */
export const STATE_TONE: Record<ClockState, { bg: string; text: string; bar: string }> = {
  ok: { bg: '#E8F5E9', text: '#27AE60', bar: '#27AE60' },
  met: { bg: '#E8F5E9', text: '#27AE60', bar: '#27AE60' },
  risk: { bg: '#FFF3E0', text: '#F39C12', bar: '#F39C12' },
  breached: { bg: '#FFEBEE', text: '#E74C3C', bar: '#E74C3C' },
  missed: { bg: '#FFEBEE', text: '#E74C3C', bar: '#E74C3C' },
  paused: { bg: '#F1F5F9', text: '#64748B', bar: '#94A3B8' },
  excused: { bg: '#F1F5F9', text: '#64748B', bar: '#94A3B8' },
};

/** How far past its budget a clock ran: "35m". The one "over" figure every surface shows
 *  (budget = the hand-set due when there is one, so a hand-set due changes it everywhere at once). */
export const overBy = (r: ClockResult) => fmtDur(Math.max(0, r.counted - r.budget));

/** Short value for pills: "1h 15m left", "45m over", "Paused", "Met". */
export function shortValue(r: ClockResult) {
  switch (r.state) {
    case 'ok': case 'risk': return `${fmtDur(r.left)} left`;
    case 'paused': return 'Paused';
    case 'breached': case 'missed': return `${overBy(r)} over`;
    case 'met': return fmtDur(r.counted);
    case 'excused': return 'Excused';
  }
}

export const handedOver = (r: ClockResult) => r.state === 'met' && r.def.doneVerb === 'Handed over';
/** The state chip: STATE_LABEL, except a finished team clock reads "Handed over" (grey). */
export function clockChip(r: ClockResult) {
  return handedOver(r) ? { label: 'Handed over', tone: STATE_TONE.paused } : { label: STATE_LABEL[r.state], tone: STATE_TONE[r.state] };
}
/** The big number on a clock card: "35m over", "1h 10m of 1h 30m", "Met in 14m", "1h 15m left". */
export function clockValue(r: ClockResult) {
  if (r.breached) return `${overBy(r)} over`;
  if (handedOver(r)) return `${fmtDur(r.counted)} of ${fmtDur(r.budget)}`;
  if (r.state === 'met') return `Met in ${fmtDur(r.counted)}`;
  return `${fmtDur(r.left)} left`;
}

/** Clock state → the list's DueByPill tone (TicketTable's SlaTone). */
export const PILL_TONE = { ok: 'ok', risk: 'due', paused: 'paused', breached: 'breached', missed: 'breached', met: 'done', excused: 'done' } as const satisfies Record<ClockState, string>;
export const lower = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
/** "P2 High – Resolution SLA" → "P2 High". */
export const policyShort = (policy: string) => policy.replace(/ – .*$/, '');
export const LOAD_ERROR = "SLA times couldn't be loaded.";
/** The archived-policy note, in two sentences so a wrap can fall between them. */
export const archivedNote = (d: Date) => [`This SLA was deleted on ${d.getDate()} ${MONTHS[d.getMonth()]}.`, 'The request keeps its targets.'] as const;

/* tiny shared store so every surface reads the same scenario. All edits live on one scenario copy. */
/** The request was created at 4:10 PM; Darsh Patel picked it up (In Progress) at 4:24 PM. Pauses and the resolve follow from the scenario. */
const CREATED = D(29, 16, 10);
function storyLog(s: Scenario): StatusChange[] {
  const out: StatusChange[] = [{ at: CREATED, to: 'Open', by: 'System' }, { at: D(29, 16, 24), to: 'In Progress', by: 'Darsh Patel' }];
  for (const p of s.pauses) {
    out.push({ at: p.from, to: p.to ? p.status : s.status, by: p.by });
    if (p.to) out.push({ at: p.to, to: 'In Progress', by: p.by });
  }
  if (s.resolved) out.push({ at: s.resolved, to: 'Resolved', by: ME });
  return out.filter(c => c.at <= s.now).sort((a, b) => a.at.getTime() - b.at.getTime());
}
const fresh = (k: ScenarioKey): Scenario => { const s = SCENARIOS[k]; return { ...s, pauses: [...s.pauses], manual: { ...s.manual }, excuses: { ...s.excuses }, log: storyLog(s) }; };
let cur: Scenario = fresh('risk');
let version = 0;
/** Prototype-only: the card's group style (rail or tint), switched from the Demo chip. */
export type CardStyle = 'rail' | 'tint';
let cardStyle: CardStyle = 'rail';
/** Prototype-only: which Service Level History layout to show (A cards, B list, C focus, D steps), switched from the Demo chip. */
export type PanelStyle = 'A' | 'B' | 'C' | 'D';
let panelStyle: PanelStyle = 'A';
const subs = new Set<() => void>();
const put = (s: Scenario) => { cur = s; version++; subs.forEach(f => f()); };
const patch = (p: Partial<Scenario>) => put({ ...cur, ...p });
/** Switching scenario drops every edit, then seeds manual / excuse from the scenario's own so revert and remove work on them. */
export const setScenario = (k: ScenarioKey) => put(fresh(k));
export const setCardStyle = (c: CardStyle) => { cardStyle = c; put(cur); };
export const setPanelStyle = (p: PanelStyle) => { panelStyle = p; put(cur); };
/** The existing "edit SLA date" pencil. Same rule as the backend's dueTimeManuallyUpdated: the hand-set time wins. */
export const setManualDue = (id: ClockId, due: Date, reason: string) => patch({ manual: { ...cur.manual, [id]: { due, by: ME, at: cur.now, reason } } });
export const revertManualDue = (id: ClockId) => { const manual = { ...cur.manual }; delete manual[id]; patch({ manual }); };
export const excuse = (id: ClockId, reason: string) => patch({ excuses: { ...cur.excuses, [id]: { by: ME, at: cur.now, reason } } });
export const removeExcuse = (id: ClockId) => { const excuses = { ...cur.excuses }; delete excuses[id]; patch({ excuses }); };
/** No-SLA request: its single hand-set Due By. */
export const setDueBy = (dueBy: Date) => patch({ dueBy });
/** A pausing status opens a pause (why = the reason, or the status itself); any other status closes it. Resolved / Closed also stop the clocks. */
export function setStatus(label: string, reason?: string) {
  const now = cur.now, open = cur.pauses.some(p => !p.to);
  const log = label === cur.status ? cur.log : [...(cur.log ?? []), { at: now, to: label, by: ME }];
  if (PAUSING_STATUSES.includes(label)) {
    patch({ status: label, log, pauses: open || cur.resolved ? cur.pauses : [...cur.pauses, { from: now, to: null, why: reason || label, status: label, by: ME }] });
  } else {
    const done = label === 'Resolved' || label === 'Closed';
    patch({ status: label, log, pauses: cur.pauses.map(p => (p.to ? p : { ...p, to: now })), resolved: done ? cur.resolved ?? now : undefined });
  }
}

/** Clocks run in a fixed order: First response, Resolution, OLAs (by start), UC. */
const rank = (c: ClockDef) => (c.kind === 'UC' ? 3 : c.kind === 'OLA' ? 2 : c.id === 'resolution' ? 1 : 0);
/** The scenario's clocks, in card order. A clock shows only once it applies (e.g. the UC starts when the vendor is set). */
export function clocksFor(s: Scenario) {
  if (s.edge === 'nosla' || s.edge === 'error') return [];
  return [...CLOCKS, ...(s.extra ?? [])].filter(c => c.start <= s.now).sort((a, b) => rank(a) - rank(b) || a.start.getTime() - b.start.getTime()).map(c => calc(c, s));
}
export function useSla() {
  useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => version);
  const s = cur, none = s.edge === 'nosla' || s.edge === 'error';
  return { scenario: s, clocks: clocksFor(s), previous: none ? [] : previousClocks(s), status: s.status, edge: s.edge ?? null, cardStyle, panelStyle };
}

/** The one demo request the new SLA experience runs on. */
export const SLA_DEMO_ID = 'INC-32';
/** Non-hook read for list cells: the grid pill names the same clock as the header. */
export function slaSnapshot() {
  return { scenario: cur, lead: headerSummary(clocksFor(cur)).clock };
}

/** The most urgent clock for the header pill: running ones first (breached > risk > on track > paused), then finished (breached late > excused > met).
 *  A customer SLA that finished late ranks with the running breached clocks; in that bucket the customer's SLA wins
 *  (SLA > OLA > UC, Ruling G), then the most minutes over. Among the others the one with less time left wins, then the earlier due.
 *  The vendor clock fronts the request only when it is breached or finished late (Ruling O). */
const URGENCY: ClockState[] = ['breached', 'risk', 'ok', 'paused', 'missed', 'excused', 'met'];
const KIND_RANK = { SLA: 0, OLA: 1, UC: 2 } as const;
export function headerSummary(clocks: ClockResult[]): { clock: ClockResult | null; state: ClockState | 'none' } {
  const due = (r: ClockResult) => r.due?.getTime() ?? 9e15;
  const late = (r: ClockResult) => r.state === 'breached' || (r.state === 'missed' && r.def.kind === 'SLA');
  const urg = (r: ClockResult) => (late(r) ? 0 : URGENCY.indexOf(r.state));
  const kind = (r: ClockResult) => (late(r) ? KIND_RANK[r.def.kind] : 0);
  const quietUc = (r: ClockResult) => (r.def.kind === 'UC' && r.state !== 'breached' && r.state !== 'missed' ? 1 : 0);
  const clock = [...clocks].sort((a, b) => quietUc(a) - quietUc(b) || urg(a) - urg(b) || kind(a) - kind(b) || a.left - b.left || due(a) - due(b))[0] ?? null;
  return clock ? { clock, state: clock.state } : { clock: null, state: 'none' };
}

/* The SLA that applied before the priority change. Kept in full for visibility (SlaTargetStatus.CANCELED).
 * Its clocks ran from request creation until the change; the new SLA then recounts from creation. */
const PREV_RULE: [string, string, string][] = [['Priority', 'is', 'Medium'], ['Category', 'is', 'Network']];
export const PREVIOUS = {
  policy: 'P3 Standard', appliedAt: D(29, 16, 10), canceledAt: D(29, 17, 2), by: ME,
  change: 'Priority changed from Medium to High', rule: PREV_RULE, penaltyRule: 'No penalty on this SLA',
  clocks: [
    { id: 'first', kind: 'SLA', name: 'First response', start: D(29, 16, 10), target: 60, hours: NETWORK_HOURS,
      stop: s => (s.noReply ? undefined : s.firstReply ?? D(29, 16, 24)), stopWhy: 'first reply sent to the requester', doneVerb: 'Replied', startedWhen: 'When the request was created',
      policy: 'P3 Standard – Response SLA', rule: PREV_RULE, escalations: [] },
    { id: 'resolution', kind: 'SLA', name: 'Resolution', start: D(29, 16, 10), target: 27 * 60, hours: NETWORK_HOURS,
      stop: () => D(29, 17, 2), stopWhy: 'SLA canceled', doneVerb: 'Canceled', startedWhen: 'When the request was created',
      policy: 'P3 Standard – Resolution SLA', rule: PREV_RULE, escalations: [] },
    { id: 'ola-desk', kind: 'OLA', name: 'Service Desk · OLA', start: D(29, 16, 10), target: 240, hours: DESK_HOURS,
      stop: () => D(29, 17, 2), stopWhy: 'SLA canceled', doneVerb: 'Canceled', startedWhen: 'When the request was assigned to Service Desk',
      policy: 'P3 Standard – OLA 1 (Service Desk, 4h)', rule: [['Technician group', 'is', 'Service Desk']], escalations: [] },
  ] as ClockDef[],
};
/** The earlier SLA's clocks, frozen at the moment it was canceled (no pauses had happened yet). */
export const previousClocks = (s?: Scenario) => PREVIOUS.clocks.map(c => calc(c, { ...SCENARIOS.ok, now: PREVIOUS.canceledAt, pauses: [], manual: undefined, excuses: undefined, resolved: undefined,
  // a reply after the cancel time belongs to the new SLA, not this one
  noReply: !!s?.noReply || (!!s?.firstReply && s.firstReply > PREVIOUS.canceledAt), firstReply: s?.firstReply }));

/* The vendor was first set to Tata Communications, then changed to Airtel Business: Tata's UC was canceled. */
const UC_TATA: ClockDef = { id: 'uc', kind: 'UC', name: 'Tata Communications · UC', start: D(30, 9, 10), target: 240, hours: ALL_HOURS,
  stop: () => D(30, 9, 40), stopWhy: 'vendor changed', doneVerb: 'Canceled', startedWhen: 'When the vendor was set to Tata Communications',
  policy: 'Tata Communications – Link restore UC (4h, 24 x 7)', rule: [['Vendor', 'is', 'Tata Communications']], escalations: [] };
const VENDOR_CHANGED = D(30, 9, 40);
export interface Canceled { r: ClockResult; at: Date; why: string; by: string }
/** Every clock a change replaced (SLA, OLA and UC), frozen when it was canceled, oldest first. */
export function canceledClocks(s: Scenario): Canceled[] {
  if (s.edge === 'nosla' || s.edge === 'error') return [];
  const out: Canceled[] = [];
  if (PREVIOUS.canceledAt <= s.now) out.push(...previousClocks(s).map(r => ({ r, at: PREVIOUS.canceledAt, why: `${PREVIOUS.change}, ${PREVIOUS.policy} replaced`, by: PREVIOUS.by })));
  if (VENDOR_CHANGED <= s.now) out.push({ r: calc(UC_TATA, { ...s, now: VENDOR_CHANGED, pauses: [], manual: undefined, excuses: undefined, resolved: undefined }),
    at: VENDOR_CHANGED, why: 'Vendor changed from Tata Communications to Airtel Business', by: ME });
  return out;
}

/** How a stopped clock finished, in plain words: "Replied 4:52 PM, 12m late". */
export function finishedLine(r: ClockResult) {
  if (!r.stop) return '';
  return r.breached ? `${r.def.doneVerb} ${fmtTime(r.stop)}, ${overBy(r)} late` : `${r.def.doneVerb} ${fmtTime(r.stop)}`;
}

/* History */
export interface SlaEvent { at: Date; kind: 'attached' | 'paused' | 'resumed' | 'overridden' | 'breached' | 'met' | 'handed-over' | 'excused' | 'canceled'; text: string; by: string }
/** What happened on one clock, oldest first, up to the scenario's now. Escalations are a manager's business: they go to the Audit Trail. */
export function events(r: ClockResult, s: Scenario): SlaEvent[] {
  const { def } = r, ps = pausesOf(def, s), isBiz = bizOf(def), out: SlaEvent[] = [];
  const add = (at: Date, kind: SlaEvent['kind'], text: string, by = 'SLA engine') => { if (at <= s.now) out.push({ at, kind, text, by }); };
  add(def.start, 'attached', def.kind === 'UC'
    ? `${def.name.replace(' · UC', '')} contract applied when the vendor was set`
    : `${policyShort(def.policy)} applied, counting from ${lower(def.startedWhen)}`);
  for (const p of ps) if (p.from >= def.start && p.from <= r.end) {
    add(p.from, 'paused', `Excluded, status ${p.status}`, p.by);
    if (p.to && p.to <= r.end) add(p.to, 'resumed', p.to.getTime() - p.from.getTime() < 60000 ? 'Counting again' : `Counting again after ${fmtDur(count(p.from, p.to, isBiz))}`, p.by);
  }
  if (r.manual) add(r.manual.at, 'overridden', `Due time changed to ${fmtTime(r.manual.due)}.${r.manual.reason ? ` Reason: ${r.manual.reason}` : ''}`, r.manual.by);
  if (r.breached && r.due) add(r.due, 'breached', 'Breached');
  if (r.stop) {
    if (r.breached) add(r.stop, 'breached', finishedLine(r));
    else if (def.doneVerb === 'Handed over') add(r.stop, 'handed-over', `Handed over to ${def.stopWhy.replace(/^request moved to /, '')}`, ME);
    else add(r.stop, 'met', `Met in ${fmtDur(r.counted)}`);
  }
  if (r.excuse) add(r.excuse.at, 'excused', `Excused. Reason: ${r.excuse.reason}`, r.excuse.by);
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export type SegKind = 'run' | 'not' | 'over';
export interface Seg { kind: SegKind; from: Date; to: Date; mins: number; why?: string }
/** Where the clock's time went, in order: counted, not counted (outside business hours, or a status that stops the clock;
 *  a pause over a night shows once, as outside hours), and counted past due. */
export function timeline(r: ClockResult, s: Scenario): Seg[] {
  const ps = pausesOf(r.def, s), isBiz = bizOf(r.def), dueT = r.breached && r.due ? r.due.getTime() : Infinity, out: Seg[] = [];
  for (let t = r.def.start.getTime(); t < r.end.getTime(); t += MIN) {
    const d = new Date(t), p = ps.find(x => d >= x.from && d < (x.to ?? new Date(8.64e15)));
    const why = !isBiz(d) ? 'Outside business hours' : p ? `Status ${p.status}` : undefined;
    const kind: SegKind = why ? 'not' : t >= dueT ? 'over' : 'run';
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.why === why) { last.to = new Date(t + MIN); last.mins++; }
    else out.push({ kind, from: d, to: new Date(t + MIN), mins: 1, why });
  }
  return out;
}

/** Who held the request, and who assigned it. */
export const ASSIGNED = [
  { group: 'Service Desk', who: 'Darsh Patel', from: CREATED, to: D(29, 17, 20) as Date | null, by: 'System' },
  { group: 'Network Team', who: ME, from: D(29, 17, 20), to: null as Date | null, by: ME },
];
/** The assignment segments clipped to the clock's window, with the time counted and paused in each. `to: null` = still with them. */
export function usage(r: ClockResult, s: Scenario) {
  const { def } = r, ps = pausesOf(def, s), isBiz = bizOf(def);
  return ASSIGNED.flatMap(a => {
    const from = a.from > def.start ? a.from : def.start;
    const to = a.to && a.to <= r.end ? a.to : r.stop ?? null;
    const upTo = to ?? r.end;
    if (upTo <= from) return [];   // this stretch of the assignment is outside the clock's window
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

/* The Audit Trails tab for the demo request: the same story, in AuditTrailsTabContent's entry shape, newest first. */
const PEOPLE: Record<string, [string, string]> = { System: ['SYS', '#6B7280'], [ME]: ['SJ', '#F59E0B'], 'Darsh Patel': ['DP', '#14B8A6'] };
const stamp = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
export function slaAudit(s: Scenario) {
  const entry = (at: Date, user: string, action: string, details: string, changes: [string, string, string][] = []) =>
    ({ at, id: `${action}-${at.getTime()}`, timestamp: stamp(at), user, userInitials: PEOPLE[user][0], userColor: PEOPLE[user][1], action, details,
      changes: changes.map(([field, oldValue, newValue]) => ({ field, oldValue, newValue })) });
  const log = s.log ?? [];
  return [
    entry(CREATED, 'System', 'Request Created', 'Request was created by Darshak Modi'),
    ...log.slice(1).map((c, i) => entry(c.at, c.by, 'Status Changed', `Changed status from "${log[i].to}" to "${c.to}"`, [['Status', log[i].to, c.to]])),
    entry(D(29, 17, 2), ME, 'Priority Updated', 'Changed priority from "Medium" to "High"', [['Priority', 'Medium', 'High']]),
    entry(D(29, 17, 20), ME, 'Assignee Changed', 'Moved to Network Team and assigned to Sarah Johnson',
      [['Technician Group', 'Service Desk', 'Network Team'], ['Assignee', 'Darsh Patel', ME]]),
    entry(D(30, 9, 10), ME, 'Field Updated', 'Set vendor to Tata Communications', [['Vendor', 'None', 'Tata Communications']]),
    entry(VENDOR_CHANGED, ME, 'Field Updated', 'Changed vendor to Airtel Business', [['Vendor', 'Tata Communications', 'Airtel Business']]),
    ...clocksFor(s).flatMap(r => r.escalated.map(e => entry(e.at, 'System', 'SLA Escalated', `${r.def.name}: level ${e.level} escalation, ${e.action}`))),
  ].filter(e => e.at <= s.now).sort((a, b) => b.at.getTime() - a.at.getTime()).map(({ at: _at, ...e }, i) => ({ ...e, id: `${e.id}-${i}` }));
}
