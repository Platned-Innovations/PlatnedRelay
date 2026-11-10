import { ChatMessage, estimateMessagesTokens } from '../gateway/types';
import type { GuardrailConfig } from '../catalog/catalog.service';

export type PiiEntity = 'email' | 'phone' | 'credit_card' | 'ssn' | 'iban' | 'ip_address' | 'secret';
export const PII_ENTITIES: PiiEntity[] = ['email', 'phone', 'credit_card', 'ssn', 'iban', 'ip_address', 'secret'];

function luhn(num: string): boolean {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const DETECTORS: Record<PiiEntity, { re: RegExp; validate?: (m: string) => boolean }> = {
  secret: { re: /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[abprs]-[A-Za-z0-9-]{10,}|rly_[A-Za-z0-9_-]{30,}|AIza[0-9A-Za-z_-]{35})\b/g },
  email: { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  credit_card: { re: /\b(?:\d[ -]?){12,18}\d\b/g, validate: luhn },
  ssn: { re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  iban: { re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, validate: (m) => m.replace(/\s/g, '').length >= 15 },
  ip_address: { re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  phone: { re: /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\w)/g, validate: (m) => { const d = m.replace(/\D/g, '').length; return d >= 9 && d <= 15; } },
};

/** Most specific detectors first so generic ones (phone) don't consume card numbers, IBANs, etc. */
const DETECTION_ORDER: PiiEntity[] = ['secret', 'email', 'credit_card', 'iban', 'ssn', 'ip_address', 'phone'];

const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts|rules|messages)/i,
  /\bdisregard\s+(?:all\s+|the\s+)?(?:previous|prior|above|system)\s+(?:instructions|prompt|rules)/i,
  /\b(?:reveal|print|show|repeat|output)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+prompt|hidden\s+instructions|initial\s+instructions)/i,
  /\byou\s+are\s+now\s+(?:DAN|in\s+developer\s+mode|jailbroken|unrestricted)/i,
  /\b(?:enable|activate)\s+(?:developer|god|jailbreak)\s+mode\b/i,
  /\bpretend\s+(?:that\s+)?you\s+(?:have\s+no|are\s+not\s+bound\s+by)\s+(?:restrictions|rules|guidelines)/i,
  /<\|im_start\|>|<\|system\|>|\[INST\]|\[\/INST\]/i,
];

export interface EffectivePolicy {
  piiMode: 'off' | 'redact' | 'mask_restore' | 'block';
  piiEntities: Set<PiiEntity>;
  blocked: RegExp[];
  blockedLabels: string[];
  keywords: string[];
  injection: 'off' | 'flag' | 'block';
  maxInputTokens?: number;
  maxOutputTokens?: number;
  outputBlocked: RegExp[];
  policyIds: string[];
}

const PII_RANK = { off: 0, redact: 1, mask_restore: 2, block: 3 } as const;
const INJ_RANK = { off: 0, flag: 1, block: 2 } as const;

function safeRegex(p: string): RegExp | null {
  try {
    if (p.length > 500) return null;
    return new RegExp(p, 'i');
  } catch {
    return null;
  }
}

/** Merges several policies; the strictest setting wins. */
export function mergePolicies(policies: { id: string; config: GuardrailConfig }[]): EffectivePolicy | null {
  if (!policies.length) return null;
  const eff: EffectivePolicy = { piiMode: 'off', piiEntities: new Set(), blocked: [], blockedLabels: [], keywords: [], injection: 'off', outputBlocked: [], policyIds: [] };
  for (const { id, config: c } of policies) {
    eff.policyIds.push(id);
    if (c.pii && PII_RANK[c.pii.mode] > PII_RANK[eff.piiMode]) eff.piiMode = c.pii.mode;
    for (const e of c.pii?.entities?.length ? c.pii.entities : c.pii && c.pii.mode !== 'off' ? PII_ENTITIES : []) eff.piiEntities.add(e as PiiEntity);
    for (const b of c.blockedPatterns ?? []) {
      const re = safeRegex(b.pattern);
      if (re) {
        eff.blocked.push(re);
        eff.blockedLabels.push(b.description || b.pattern);
      }
    }
    eff.keywords.push(...(c.blockedKeywords ?? []).map((k) => k.toLowerCase()).filter(Boolean));
    if (c.promptInjection && INJ_RANK[c.promptInjection] > INJ_RANK[eff.injection]) eff.injection = c.promptInjection;
    if (c.maxInputTokens) eff.maxInputTokens = Math.min(eff.maxInputTokens ?? Infinity, c.maxInputTokens);
    if (c.maxOutputTokens) eff.maxOutputTokens = Math.min(eff.maxOutputTokens ?? Infinity, c.maxOutputTokens);
    for (const b of c.outputBlockedPatterns ?? []) {
      const re = safeRegex(b.pattern);
      if (re) eff.outputBlocked.push(re);
    }
  }
  return eff;
}

export interface PiiResult {
  text: string;
  count: number;
  found: Set<PiiEntity>;
}

/** Replaces PII in text. `vault` collects placeholder→original for mask_restore mode. */
export function redactPii(text: string, entities: Set<PiiEntity>, vault?: Map<string, string>, counters?: Map<string, number>): PiiResult {
  let out = text;
  let count = 0;
  const found = new Set<PiiEntity>();
  for (const entity of DETECTION_ORDER) {
    if (!entities.has(entity)) continue;
    const { re, validate } = DETECTORS[entity];
    out = out.replace(re, (m) => {
      if (/^\[[A-Z_]+(?:_\d+)?\]$/.test(m)) return m;
      if (validate && !validate(m)) return m;
      count++;
      found.add(entity);
      const label = entity.toUpperCase();
      if (!vault) return `[${label}]`;
      for (const [ph, orig] of vault) if (orig === m) return ph;
      const n = (counters?.get(label) ?? 0) + 1;
      counters?.set(label, n);
      const ph = `[${label}_${n}]`;
      vault.set(ph, m);
      return ph;
    });
  }
  return { text: out, count, found };
}

export interface InputCheck {
  messages: ChatMessage[];
  redactions: number;
  flags: string[];
  blocked?: string;
  vault?: Map<string, string>;
}

function mapText(m: ChatMessage, fn: (s: string) => string): ChatMessage {
  if (typeof m.content === 'string') return { ...m, content: fn(m.content) };
  if (Array.isArray(m.content)) return { ...m, content: m.content.map((p: any) => (p.type === 'text' ? { ...p, text: fn(p.text) } : p)) };
  return m;
}

function allText(messages: ChatMessage[]): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => (p.type === 'text' ? p.text : '')).join(' ') : ''))
    .join('\n');
}

export function checkInput(messages: ChatMessage[], policy: EffectivePolicy | null): InputCheck {
  if (!policy) return { messages, redactions: 0, flags: [] };
  const flags: string[] = [];
  const userText = allText(messages.filter((m) => m.role !== 'system' && m.role !== 'developer' && m.role !== 'assistant'));

  if (policy.maxInputTokens && estimateMessagesTokens(messages) > policy.maxInputTokens) {
    return { messages, redactions: 0, flags: ['max_input_tokens'], blocked: `Input exceeds the ${policy.maxInputTokens} token limit set by policy` };
  }
  for (let i = 0; i < policy.blocked.length; i++) {
    if (policy.blocked[i].test(userText)) return { messages, redactions: 0, flags: ['blocked_pattern'], blocked: `Request blocked by policy rule: ${policy.blockedLabels[i]}` };
  }
  const lower = userText.toLowerCase();
  const kw = policy.keywords.find((k) => lower.includes(k));
  if (kw) return { messages, redactions: 0, flags: ['blocked_keyword'], blocked: 'Request contains a blocked keyword' };

  if (policy.injection !== 'off' && INJECTION_PATTERNS.some((re) => re.test(userText))) {
    if (policy.injection === 'block') return { messages, redactions: 0, flags: ['prompt_injection'], blocked: 'Request blocked: possible prompt injection detected' };
    flags.push('prompt_injection');
  }

  if (policy.piiMode === 'off' || !policy.piiEntities.size) return { messages, redactions: 0, flags };
  if (policy.piiMode === 'block') {
    const probe = redactPii(allText(messages), policy.piiEntities);
    if (probe.count) return { messages, redactions: 0, flags: ['pii'], blocked: `Request contains sensitive data (${[...probe.found].join(', ')}) and policy blocks it` };
    return { messages, redactions: 0, flags };
  }
  const vault = policy.piiMode === 'mask_restore' ? new Map<string, string>() : undefined;
  const counters = new Map<string, number>();
  let redactions = 0;
  const out = messages.map((m) =>
    mapText(m, (s) => {
      const r = redactPii(s, policy.piiEntities, vault, counters);
      redactions += r.count;
      return r.text;
    }),
  );
  if (redactions) flags.push('pii_redacted');
  return { messages: out, redactions, flags, vault };
}

export function restorePii(text: string, vault?: Map<string, string>): string {
  if (!vault?.size || !text) return text;
  return text.replace(/\[[A-Z_]+_\d+\]/g, (ph) => vault.get(ph) ?? ph);
}

/** Streaming-safe restorer: holds back a possibly-incomplete trailing placeholder. */
export class StreamRestorer {
  private pending = '';
  constructor(private readonly vault?: Map<string, string>) {}
  push(delta: string): string {
    if (!this.vault?.size) return delta;
    const text = this.pending + delta;
    const open = text.lastIndexOf('[');
    if (open >= 0 && text.indexOf(']', open) < 0 && text.length - open < 40) {
      this.pending = text.slice(open);
      return restorePii(text.slice(0, open), this.vault);
    }
    this.pending = '';
    return restorePii(text, this.vault);
  }
  flush(): string {
    const p = this.pending;
    this.pending = '';
    return restorePii(p, this.vault);
  }
}

export function checkOutput(text: string, policy: EffectivePolicy | null): string | undefined {
  if (!policy || !text) return undefined;
  for (const re of policy.outputBlocked) if (re.test(text)) return 'Response withheld by output policy';
  return undefined;
}
