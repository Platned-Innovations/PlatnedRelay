import { useMemo } from 'react';

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Validates that `text` is empty or a JSON object (optionally with only string values). */
export function validateJsonObject(text: string, stringValues = false): string | null {
  const r = parseJson(text);
  if (!r.ok) return r.error;
  if (r.value === undefined) return null;
  if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)) return 'Must be a JSON object';
  if (stringValues && Object.values(r.value as Record<string, unknown>).some((v) => typeof v !== 'string')) return 'All values must be strings';
  return null;
}

/** Textarea JSON editor with live validation. */
export function JsonEditor({
  value,
  onChange,
  rows = 8,
  placeholder,
  objectOnly = true,
  stringValues,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  objectOnly?: boolean;
  stringValues?: boolean;
  disabled?: boolean;
}) {
  const error = useMemo(() => {
    if (objectOnly) return validateJsonObject(value, stringValues);
    const r = parseJson(value);
    return r.ok ? null : r.error;
  }, [value, objectOnly, stringValues]);
  return (
    <div>
      <textarea
        className={`textarea mono${error ? ' invalid' : ''}`}
        rows={rows}
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="row between small" style={{ marginTop: 4 }}>
        {error ? <span className="danger-text">Invalid JSON: {error}</span> : <span className="muted">{value.trim() ? 'Valid JSON' : 'Empty'}</span>}
        {!error && value.trim() && !disabled && (
          <button
            type="button"
            className="link-btn small"
            onClick={() => {
              const r = parseJson(value);
              if (r.ok && r.value !== undefined) onChange(JSON.stringify(r.value, null, 2));
            }}
          >
            Format
          </button>
        )}
      </div>
    </div>
  );
}
