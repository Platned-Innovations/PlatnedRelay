import { RefreshCw } from 'lucide-react';
import { fromLocalInput, toLocalInput } from '../format';

export type RangePreset = '24h' | '7d' | '30d' | '90d' | 'custom';
export interface DateRange {
  preset: RangePreset;
  from: string; // ISO
  to: string; // ISO
}

const HOURS: Record<Exclude<RangePreset, 'custom'>, number> = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30, '90d': 24 * 90 };

export function presetRange(preset: Exclude<RangePreset, 'custom'>): DateRange {
  const to = new Date();
  const from = new Date(to.getTime() - HOURS[preset] * 3600_000);
  return { preset, from: from.toISOString(), to: to.toISOString() };
}

export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const presets: Exclude<RangePreset, 'custom'>[] = ['24h', '7d', '30d', '90d'];
  return (
    <div className="drp">
      <div className="btn-group" role="group" aria-label="Date range">
        {presets.map((p) => (
          <button key={p} type="button" className={`btn btn-sm${value.preset === p ? ' active' : ''}`} onClick={() => onChange(presetRange(p))}>
            {p}
          </button>
        ))}
        <button type="button" className={`btn btn-sm${value.preset === 'custom' ? ' active' : ''}`} onClick={() => onChange({ ...value, preset: 'custom' })}>
          Custom
        </button>
      </div>
      {value.preset === 'custom' ? (
        <>
          <input
            type="datetime-local"
            className="input input-sm"
            aria-label="From"
            value={toLocalInput(value.from)}
            onChange={(e) => {
              const iso = fromLocalInput(e.target.value);
              if (iso) onChange({ ...value, from: iso });
            }}
          />
          <span className="muted">to</span>
          <input
            type="datetime-local"
            className="input input-sm"
            aria-label="To"
            value={toLocalInput(value.to)}
            onChange={(e) => {
              const iso = fromLocalInput(e.target.value);
              if (iso) onChange({ ...value, to: iso });
            }}
          />
        </>
      ) : (
        <button type="button" className="btn btn-sm btn-ghost" title="Refresh (move range to now)" onClick={() => onChange(presetRange(value.preset as Exclude<RangePreset, 'custom'>))}>
          <RefreshCw size={13} />
        </button>
      )}
    </div>
  );
}
