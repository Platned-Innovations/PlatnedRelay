import { useCallback, useEffect, useRef, useState } from 'react';
import { Radio } from 'lucide-react';

const INTERVALS = [5, 10, 30, 60];

function readPref(key: string): { on: boolean; seconds: number } {
  try {
    const v = JSON.parse(localStorage.getItem(`relay.live.${key}`) ?? 'null');
    if (v && typeof v.on === 'boolean' && INTERVALS.includes(v.seconds)) return v;
  } catch {
    /* storage unavailable */
  }
  return { on: false, seconds: 10 };
}

function writePref(key: string, v: { on: boolean; seconds: number }) {
  try {
    localStorage.setItem(`relay.live.${key}`, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export interface LiveMode {
  on: boolean;
  seconds: number;
  lastTick: Date | null;
  setOn: (on: boolean) => void;
  setSeconds: (s: number) => void;
}

/**
 * Polls `onTick` every N seconds while enabled. Pauses while the browser tab is
 * hidden and ticks immediately when it becomes visible again. The on/off choice
 * and interval are remembered per page.
 */
export function useLiveMode(pageKey: string, onTick: () => void): LiveMode {
  const [pref, setPref] = useState(() => readPref(pageKey));
  const [lastTick, setLastTick] = useState<Date | null>(null);
  const tickRef = useRef(onTick);
  tickRef.current = onTick;

  const update = useCallback(
    (next: { on: boolean; seconds: number }) => {
      setPref(next);
      writePref(pageKey, next);
    },
    [pageKey],
  );

  useEffect(() => {
    if (!pref.on) return;
    const tick = () => {
      if (document.hidden) return;
      tickRef.current();
      setLastTick(new Date());
    };
    tick(); // immediate refresh when turned on
    const id = window.setInterval(tick, pref.seconds * 1000);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pref.on, pref.seconds]);

  return {
    on: pref.on,
    seconds: pref.seconds,
    lastTick,
    setOn: (on) => update({ ...pref, on }),
    setSeconds: (seconds) => update({ ...pref, seconds }),
  };
}

export function LiveToggle({ live }: { live: LiveMode }) {
  return (
    <div className={`live-toggle${live.on ? ' on' : ''}`}>
      <button
        type="button"
        className="btn btn-sm live-btn"
        aria-pressed={live.on}
        onClick={() => live.setOn(!live.on)}
        title={live.on ? 'Stop live updates' : 'Refresh automatically'}
      >
        {live.on ? <span className="live-dot" aria-hidden /> : <Radio size={13} />}
        {live.on ? 'Live' : 'Go live'}
      </button>
      {live.on && (
        <>
          <select className="select select-sm" aria-label="Refresh interval" value={live.seconds} onChange={(e) => live.setSeconds(Number(e.target.value))}>
            {INTERVALS.map((s) => (
              <option key={s} value={s}>
                every {s}s
              </option>
            ))}
          </select>
          {live.lastTick && <span className="muted small live-updated">updated {live.lastTick.toLocaleTimeString()}</span>}
        </>
      )}
    </div>
  );
}

/**
 * Keys of rows that appeared since the previous refresh (for a brief highlight).
 * Resets when `scope` changes (filters/page), so changing filters never flashes rows.
 */
export function useNewRowKeys<T>(rows: T[] | undefined, rowKey: (r: T) => string, enabled: boolean, scope: string): Set<string> {
  const prev = useRef<{ scope: string; keys: Set<string> } | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!rows) return;
    const keys = new Set(rows.map(rowKey));
    const before = prev.current;
    if (enabled && before && before.scope === scope) {
      const added = new Set([...keys].filter((k) => !before.keys.has(k)));
      setFresh(added);
    } else {
      setFresh(new Set());
    }
    prev.current = { scope, keys };
    // rowKey is a stable accessor in practice; rows identity drives updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, enabled, scope]);

  return fresh;
}
