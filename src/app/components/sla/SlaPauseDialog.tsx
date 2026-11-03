import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { PAUSE_REASONS, type ClockResult } from './slaEngine';

/* Asked when a request moves into Pending / On Hold: which clocks stop, and why (optional). Same chrome as the other centred modals. */

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3D8BD0]/40';
const plain = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);

interface Props { status: string; clocks: ClockResult[]; onCancel: () => void; onConfirm: (reason?: string) => void }

export function SlaPauseDialog({ status, clocks, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState('');
  const select = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    select.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  // Pending and On Hold stop the SLA and the OLAs; the UC has its own flag and keeps running here.
  const running = clocks.filter(c => c.state === 'ok' || c.state === 'risk' || c.state === 'breached');
  const stops = running.filter(c => c.def.kind !== 'UC').map(c => c.def.name);
  const goes = running.filter(c => c.def.kind === 'UC').map(c => c.def.name);
  const text = !stops.length && !goes.length ? 'No SLA clocks are running, so nothing pauses.'
    : `${stops.length ? `${plain(stops)} ${stops.length > 1 ? 'stop' : 'stops'} counting while the request is ${status}.` : `No SLA clocks pause while the request is ${status}.`}${goes.length ? ` ${plain(goes)} keeps running.` : ''}`;

  return createPortal(
    <div className="fixed inset-0 z-[10005] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div role="dialog" aria-modal="true" aria-labelledby="sla-pause-title" className="relative w-full max-w-[440px] overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#E5E7EB] px-5 py-3">
          <h2 id="sla-pause-title" className="text-[16px] font-semibold text-[#364658]">SLA clocks will pause</h2>
          <button onClick={onCancel} aria-label="Close" className={`flex size-8 flex-shrink-0 items-center justify-center rounded text-[#6B7280] transition-colors hover:bg-[#F3F4F6] hover:text-[#111827] ${FOCUS}`}><X size={18} /></button>
        </div>
        <div className="px-5 py-4">
          <p className="text-[13px] text-[#4A5568]">{text}</p>
          <label htmlFor="sla-pause-reason" className="mt-4 block text-[12px] text-[#4A5568]">Why? (optional)</label>
          <select id="sla-pause-reason" ref={select} value={reason} onChange={e => setReason(e.target.value)}
            className={`app-select mt-1 w-full rounded border border-[#DFE5ED] bg-white px-3 py-2 text-[13px] focus:border-[#3D8BD0] focus:outline-none focus:ring-2 focus:ring-[#3D8BD0]/20 ${reason ? 'text-[#364658]' : 'text-[#9CA3AF]'}`}>
            <option value="">Choose a reason</option>
            {PAUSE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-[#E5E7EB] px-5 py-3">
          <button onClick={onCancel} className={`rounded border border-[#DFE5ED] px-4 py-1.5 text-[13px] font-medium text-[#364658] transition-colors hover:bg-[#F3F4F6] ${FOCUS}`}>Cancel</button>
          <button onClick={() => onConfirm(reason || undefined)} className={`rounded bg-[#3D8BD0] px-4 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-[#3479B8] ${FOCUS}`}>Change to {status}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
