// Run from the app root: node src/app/components/sla/slaEngine.check.ts   (prints "ok")
import assert from 'node:assert/strict';
import {
  CLOCKS, calc, D, fmtDue, fmtDur, finishedLine, headerSummary, events, usage, whyThis, shortValue, clockValue, overBy, clocksFor,
  setScenario, setManualDue, revertManualDue, excuse, removeExcuse, setStatus, slaSnapshot, PREVIOUS, previousClocks,
  STATE_LABEL, type ScenarioKey, type ClockId, type ClockResult,
} from './slaEngine.ts';

// Compute a scenario's clocks without React (useSla is a hook); the store holds the same Scenario.
const clocksOf = (k?: ScenarioKey) => {
  if (k) setScenario(k);
  const s = slaSnapshot().scenario;
  return Object.fromEntries([...CLOCKS, ...(s.extra ?? [])].filter(c => c.start <= s.now).map(c => [c.id, calc(c, s)])) as Partial<Record<ClockId, ClockResult>>;
};
const sc = () => slaSnapshot().scenario;
const hhmm = (d: Date | null | undefined) => d && `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

// risk: Resolution ~1h 15m left, due today 4:20 PM; Network OLA ~25m left; header picks the OLA
{
  const c = clocksOf('risk');
  assert.equal(c.resolution!.state, 'risk');
  assert.equal(c.resolution!.left, 75);
  assert.equal(hhmm(c.resolution!.due), '16:20');
  assert.equal(fmtDue(c.resolution!.due!, sc().now), 'today 4:20 PM IST');
  assert.equal(c['ola-network']!.state, 'risk');
  assert.equal(c['ola-network']!.left, 25);
  assert.equal(c.first!.state, 'met');
  assert.equal(finishedLine(c.first!), 'Replied 4:24 PM');
  assert.equal(c.resolution!.escLevel, 1);
  const h = headerSummary(Object.values(c) as ClockResult[]);
  assert.equal(h.state, 'risk');
  assert.equal(h.clock!.def.id, 'ola-network');
  // tie on state and time left: the earlier due wins
  const twin = { ...c.resolution!, left: 25 };
  assert.equal(headerSummary([twin, c['ola-network']!]).clock!.def.id, 'ola-network');
  assert.deepEqual(headerSummary([]), { clock: null, state: 'none' });
}

// the story: first response stays Met after the priority change, Service Desk OLA handed over, UC met in 3h 45m
{
  const c = clocksOf('risk');
  const desk = c['ola-desk']!;
  assert.equal(desk.state, 'met');
  assert.equal(desk.counted, 70);
  assert.equal(finishedLine(desk), 'Handed over 5:20 PM');
  assert.equal(c['ola-network']!.def.target, 360);
  assert.equal(c.uc!.state, 'met');
  assert.equal(c.uc!.counted, 225);
  assert.equal(fmtDue(D(1, 9, 30), D(0, 12, 0)), 'tomorrow 9:30 AM IST');
  assert.equal(fmtDue(D(30, 16, 20), D(29, 12, 0)), 'tomorrow 4:20 PM IST');
  assert.equal(fmtDue(D(30, 16, 20), D(28, 12, 0)), 'Wed 30 Sep, 4:20 PM IST');
  const u = usage(desk, sc());
  assert.deepEqual(u.map(x => [x.group, x.who, x.counted]), [['Service Desk', 'Darsh Patel', 70]]);
  const ur = usage(c.resolution!, sc());
  assert.deepEqual(ur.map(x => x.group), ['Service Desk', 'Network Team']);
  assert.equal(ur[1].to, null);
  assert.deepEqual(usage(c['ola-network']!, sc()).map(x => [x.group, x.who]), [['Network Team', 'Sarah Johnson']]);
  const uu = usage(c.uc!, sc());
  assert.deepEqual(uu.map(x => [x.group, hhmm(x.from), hhmm(x.to)]), [['Network Team', '9:40', '13:25']]);
  assert.equal(uu[0].counted, 225);
  for (const k of ['ola-network', 'uc'] as const) for (const x of usage(c[k]!, sc())) assert.ok(x.to === null || x.to > x.from);
  const w = whyThis(c.resolution!);
  assert.equal(w.matched, 'Priority is High and Category is Network');
  assert.equal(w.hours, 'Network Team hours, Mon–Fri 9 AM–6 PM IST');
  assert.equal(w.started, 'When the request was created, Tue 29 Sep, 4:10 PM');
  assert.equal(previousClocks(sc()).length, 2);
  assert.equal(PREVIOUS.canceledAt.getHours(), 17);
}

// breached: Resolution breached by 45m, $50, escalation level 2; Network OLA breached
{
  const c = clocksOf('breached');
  assert.equal(c.resolution!.state, 'breached');
  assert.equal(c.resolution!.left, -45);
  assert.equal(c.resolution!.penalty, 50);
  assert.equal(c.resolution!.escLevel, 2);
  assert.equal(c['ola-network']!.state, 'breached');
  assert.equal(c['ola-network']!.penalty, 0);
  const ev = events(c.resolution!, sc());
  assert.ok(ev.some(e => e.kind === 'breached' && e.text === 'Breached' && hhmm(e.at) === '16:20'));
  assert.ok(ev.some(e => e.kind === 'escalated' && e.text === 'Level 1 escalation: email to Priya Mehta (Network Team manager)'));
  assert.ok(ev.some(e => e.kind === 'escalated' && e.text.startsWith('Level 2 escalation: reassigned to Priya Mehta')));
  assert.ok(ev.some(e => e.kind === 'resumed' && e.text === 'Resumed after 1h 10m'));
  assert.ok(ev.some(e => e.kind === 'paused' && e.text === 'Paused, waiting on requester'));
  assert.equal(ev[0].text, 'P2 High applied, counting from when the request was created');
  assert.equal(events(c.uc!, sc())[0].text, 'Airtel contract applied when the vendor was set');
  assert.deepEqual(ev.map(e => e.at.getTime()), [...ev.map(e => e.at.getTime())].sort((a, b) => a - b));
  // both Resolution and the Network Team OLA are breached: the customer's SLA leads the header
  const hb = headerSummary(Object.values(c) as ClockResult[]);
  assert.equal(hb.state, 'breached');
  assert.equal(hb.clock!.def.id, 'resolution');
}

// paused: Resolution paused with no due; Pending pauses SLA and OLA but not the UC
{
  const c = clocksOf('paused');
  assert.equal(c.resolution!.state, 'paused');
  assert.equal(c.resolution!.due, null);
  assert.equal(c['ola-network']!.state, 'paused');
  const ok = clocksOf('ok');
  assert.equal(ok.uc!.state, 'ok');
  setStatus('Pending', 'Waiting on vendor');
  const p = clocksOf();
  assert.equal(p.resolution!.state, 'paused');
  assert.equal(p['ola-network']!.state, 'paused');
  assert.equal(p.uc!.state, 'ok');           // the UC keeps running
  assert.equal(p.first!.state, 'met');       // already finished, untouched
}

// manual: the hand-set 5:30 PM wins; penalty counts the minutes after it once now passes it
{
  const c = clocksOf('manual');
  assert.equal(hhmm(c.resolution!.due), '17:30');
  assert.equal(c.resolution!.manual!.by, 'Sarah Johnson');
  assert.equal(c.resolution!.state, 'ok');
  assert.equal(c.resolution!.left, 145);
  assert.equal(c.resolution!.penalty, 0);
  revertManualDue('resolution');             // built-in manual can be reverted
  assert.equal(hhmm(clocksOf().resolution!.due), '16:20');
  clocksOf('breached');
  setManualDue('resolution', D(30, 15, 0), '');   // 2h 05m past the hand-set due: 3 started hours
  assert.equal(clocksOf().resolution!.penalty, 150);
  assert.ok(events(clocksOf().resolution!, sc()).some(e => e.kind === 'overridden' && e.text === 'Due time changed to 3:00 PM.'));
}

// excused: state excused, penalty 0; built-in excuse can be removed
{
  const c = clocksOf('excused');
  assert.equal(c.resolution!.state, 'excused');
  assert.equal(c.resolution!.breached, true);
  assert.equal(c.resolution!.penalty, 0);
  assert.equal(c.resolution!.excuse!.by, 'Sarah Johnson');
  assert.ok(events(c.resolution!, sc()).some(e => e.kind === 'excused' && e.text === 'Excused. Reason: Airtel circuit outage, agreed with requester'));
  removeExcuse('resolution');
  assert.equal(clocksOf().resolution!.state, 'breached');
  assert.equal(clocksOf().resolution!.penalty, 50);
  excuse('resolution', 'Customer waived it');
  assert.equal(clocksOf().resolution!.state, 'excused');
  assert.equal(STATE_LABEL.excused, 'Excused');
}

// late reply: First response is missed (shown as Breached), never met; overdue: breached while still waiting
{
  const c = clocksOf('late');
  assert.equal(c.first!.state, 'missed');
  assert.equal(STATE_LABEL[c.first!.state], 'Breached');
  assert.equal(finishedLine(c.first!), 'Replied 5:15 PM, 35m late');
  const o = clocksOf('overdue');
  assert.equal(o.first!.state, 'breached');
  assert.equal(hhmm(o.first!.due), '16:40');
  assert.equal(o['ola-network'], undefined);   // not started yet
}

// Service Desk OLA is met and reads "Handed over"
{
  const c = clocksOf('breached');
  assert.equal(c['ola-desk']!.state, 'met');
  assert.equal(finishedLine(c['ola-desk']!), 'Handed over 5:20 PM');
  assert.ok(events(c['ola-desk']!, sc()).some(e => e.kind === 'handed-over' && e.text === 'Handed over to Network Team'));
  assert.equal(fmtDur(c['ola-desk']!.def.target), '1h 30m');
}

// status changes: On Hold then In Progress gives a paused and a resumed event; Resolved stops the clocks
{
  clocksOf('risk');
  setStatus('On Hold', 'Waiting on requester');
  assert.equal(sc().status, 'On Hold');
  assert.equal(clocksOf().resolution!.state, 'paused');
  setStatus('In Progress');
  const ev = events(clocksOf().resolution!, sc());
  assert.equal(ev.filter(e => e.kind === 'paused').length, 2);    // the earlier 10:30 pause plus this one
  assert.equal(ev.filter(e => e.kind === 'resumed').length, 2);
  assert.ok(ev.some(e => e.kind === 'resumed' && e.text === 'Resumed'));   // a pause under a minute has no "after 0m"
  assert.ok(!ev.some(e => /after 0m/.test(e.text)));
  assert.ok(ev.some(e => e.kind === 'paused' && hhmm(e.at) === '15:05'));
  assert.equal(clocksOf().resolution!.state, 'risk');
  setStatus('Resolved');
  const r = clocksOf();
  assert.equal(r.resolution!.state, 'met');
  assert.equal(r['ola-network']!.state, 'met');
  assert.ok(events(r.resolution!, sc()).some(e => e.kind === 'met'));
}

// met scenario and edge scenarios
{
  const c = clocksOf('met');
  assert.equal(c.resolution!.state, 'met');
  assert.equal(c.resolution!.stop && hhmm(c.resolution!.stop), '14:12');
  clocksOf('nosla'); assert.equal(sc().edge, 'nosla'); assert.equal(hhmm(sc().dueBy), '18:00');
  clocksOf('archived'); assert.equal(sc().edge, 'archived'); assert.equal(hhmm(sc().deletedOn), '13:00');
  clocksOf('error'); assert.equal(sc().edge, 'error');
  const m = clocksOf('many');
  assert.equal(Object.keys(m).length, 7);
  assert.deepEqual(usage(m['ola-db']!, sc()).map(x => x.group), ['Network Team']);
  assert.equal(m['ola-db']!.state, 'paused');
  assert.equal(m['ola-sec']!.state, 'paused');
  setScenario('risk');
  assert.equal(sc().edge, undefined);
}

// one "over" figure: a hand-set due in the past, then Resolve. Card, slide-over, list pill and timeline all say 1h 05m.
{
  clocksOf('risk');
  setManualDue('resolution', D(30, 14, 0), '');
  setStatus('Resolved');
  const r = clocksOf().resolution!;
  assert.equal(r.state, 'missed');
  assert.equal(overBy(r), '1h 05m');
  assert.equal(shortValue(r), '1h 05m over');           // card and list pill
  assert.equal(clockValue(r), '1h 05m over');           // slide-over and transition dialog
  assert.equal(finishedLine(r), 'Resolved 3:05 PM, 1h 05m late');   // timeline
  assert.ok(events(r, sc()).some(e => e.kind === 'breached' && e.text === 'Resolved 3:05 PM, 1h 05m late'));
  assert.equal(slaSnapshot().lead!.def.id, 'resolution');   // the finished-late customer SLA leads header and list
  assert.equal(sc().log!.at(-1)!.to, 'Resolved');
  // the level 2 the hand-set due triggers is sent when the due was set (3:05 PM), not back-dated to 2:00 PM
  assert.deepEqual(r.escalated.map(e => [e.level, hhmm(e.at)]), [[1, '14:20'], [2, '15:05']]);
}

// a customer SLA that finished late reaches the header; the list pill always names the header's clock
{
  const c = clocksOf('late');
  const h = headerSummary(Object.values(c) as ClockResult[]);
  assert.equal(h.clock!.def.id, 'first');
  assert.equal(h.state, 'missed');
  clocksOf('overdue');
  assert.equal(headerSummary(clocksFor(sc())).clock!.def.id, 'first');
  assert.equal(slaSnapshot().lead!.def.id, 'first');
  assert.equal(shortValue(slaSnapshot().lead!), '30m over');
}

// Ruling O: the vendor clock never fronts a request unless it is breached or finished late
{
  const c = clocksOf('ok');
  assert.equal(c.uc!.state, 'ok');
  const h = headerSummary(Object.values(c) as ClockResult[]);
  assert.equal(h.clock!.def.id, 'ola-network');
  assert.equal(h.state, 'ok');
  const lateUc = { ...c.uc!, state: 'breached' as const, left: -5 };
  assert.equal(headerSummary([c.resolution!, lateUc]).clock!.def.id, 'uc');
}

// a hand-set due keeps the escalation already sent under the policy time
{
  const r = clocksOf('manual').resolution!;
  assert.equal(r.escLevel, 1);
  assert.equal(hhmm(r.escalated[0].at), '14:20');
  assert.ok(events(r, sc()).some(e => e.kind === 'escalated' && e.text.startsWith('Level 1') && hhmm(e.at) === '14:20'));
}

// status log: the story, then every change made on the page
{
  clocksOf('paused');
  assert.deepEqual(sc().log!.map(c => [c.to, hhmm(c.at)]), [['Open', '16:10'], ['In Progress', '16:24'], ['Pending', '10:30'], ['In Progress', '11:40'], ['Pending', '14:40']]);
  clocksOf('ok');
  assert.equal(sc().log!.length, 2);   // the 10:30 pause hasn't happened yet at 10:15
  setScenario('risk');
}

console.log('ok');
