import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { NotificationSettings, SettingsService } from '../settings/settings.service';

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text?: string;
}

export interface NotifyOptions {
  event: string;
  subject: string;
  /** Short heading + paragraphs rendered into the standard template. */
  title: string;
  lines: string[];
  action?: { label: string; url: string };
  /** Explicit recipients. Admin recipients are added when `includeAdmins` is true. */
  to?: string[];
  includeAdmins?: boolean;
  relatedId?: string;
  /** Structured payload for webhooks. */
  data?: Record<string, unknown>;
  /** Send even if the event toggle is off (e.g. explicit "send invite email"). */
  force?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderEmail(title: string, lines: string[], action?: { label: string; url: string }): { html: string; text: string } {
  const body = lines.map((l) => `<p style="margin:0 0 12px;line-height:1.5">${esc(l)}</p>`).join('');
  const button = action
    ? `<p style="margin:20px 0"><a href="${esc(action.url)}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${esc(action.label)}</a></p>
       <p style="font-size:12px;color:#6b7280">Or open: ${esc(action.url)}</p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#111827">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
  <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;padding:28px">
  <tr><td><div style="font-weight:700;color:#4f46e5;margin-bottom:16px">Relay · LLM Gateway</div>
  <h2 style="margin:0 0 16px;font-size:20px">${esc(title)}</h2>${body}${button}
  <p style="font-size:12px;color:#9ca3af;margin-top:24px">This is an automated message from the Relay LLM Gateway.</p></td></tr></table>
  </td></tr></table></body></html>`;
  const text = [title, '', ...lines, action ? `\n${action.label}: ${action.url}` : ''].join('\n');
  return { html, text };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');
  private graphToken?: { token: string; exp: number; key: string };

  constructor(private readonly store: Store, private readonly settings: SettingsService) {}

  async notify(opts: NotifyOptions): Promise<void> {
    const cfg = await this.settings.get('notifications');
    const eventEnabled = opts.force || cfg.events[opts.event] !== false;
    const recipients = new Set((opts.to ?? []).filter(Boolean).map((s) => s.trim().toLowerCase()));
    if (opts.includeAdmins) cfg.adminRecipients.forEach((r) => recipients.add(r.trim().toLowerCase()));

    if (cfg.enabled && cfg.channel !== 'none' && eventEnabled && recipients.size) {
      const { html, text } = renderEmail(opts.title, opts.lines, opts.action);
      await this.deliver(cfg, { to: [...recipients], subject: opts.subject, html, text }, opts.event, opts.relatedId);
    }
    if (eventEnabled) await this.fireWebhooks(cfg, opts);
  }

  /** Send a raw email (used by "send test email"). Throws on failure. */
  async sendTest(to: string): Promise<void> {
    const cfg = await this.settings.get('notifications');
    if (cfg.channel === 'none') throw new Error('No email channel configured');
    const { html, text } = renderEmail('Test email', ['Your Relay email configuration works.', `Channel: ${cfg.channel.toUpperCase()}`]);
    await this.sendEmail(cfg, { to: [to], subject: 'Relay test email', html, text });
    await this.logNotification('test', cfg.channel, [to], 'Relay test email', 'sent');
  }

  private async deliver(cfg: NotificationSettings, msg: EmailMessage, event: string, relatedId?: string) {
    try {
      await this.sendEmail(cfg, msg);
      await this.logNotification(event, cfg.channel, msg.to, msg.subject, 'sent', undefined, relatedId);
    } catch (e: any) {
      this.logger.warn(`Email for ${event} failed: ${e.message}`);
      await this.logNotification(event, cfg.channel, msg.to, msg.subject, 'failed', e.message, relatedId);
    }
  }

  private async sendEmail(cfg: NotificationSettings, msg: EmailMessage) {
    if (!cfg.fromAddress && cfg.channel === 'smtp') throw new Error('From address is not configured');
    if (cfg.channel === 'smtp') {
      const transport = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        auth: cfg.smtp.username ? { user: cfg.smtp.username, pass: cfg.smtp.password } : undefined,
        requireTLS: !cfg.smtp.secure,
        connectionTimeout: 15_000,
      });
      await transport.sendMail({
        from: cfg.fromName ? `"${cfg.fromName.replace(/"/g, '')}" <${cfg.fromAddress}>` : cfg.fromAddress,
        to: msg.to.join(', '),
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      });
      return;
    }
    if (cfg.channel === 'graph') {
      const token = await this.graphAccessToken(cfg);
      const sender = cfg.graph.senderUpn || cfg.fromAddress;
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject: msg.subject,
            body: { contentType: 'HTML', content: msg.html },
            toRecipients: msg.to.map((address) => ({ emailAddress: { address } })),
          },
          saveToSentItems: false,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Graph sendMail failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      return;
    }
    throw new Error('Email channel disabled');
  }

  private async graphAccessToken(cfg: NotificationSettings): Promise<string> {
    const { tenantId, clientId, clientSecret } = cfg.graph;
    if (!tenantId || !clientId || !clientSecret) throw new Error('Microsoft Graph tenantId, clientId and clientSecret are required');
    const key = CryptoService.sha256(`${tenantId}|${clientId}|${clientSecret}`);
    if (this.graphToken && this.graphToken.key === key && this.graphToken.exp > Date.now() + 60_000) return this.graphToken.token;
    const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: 'https://graph.microsoft.com/.default',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new Error(`Graph token request failed: ${json.error_description || res.status}`);
    this.graphToken = { token: json.access_token, exp: Date.now() + (json.expires_in ?? 3600) * 1000, key };
    return json.access_token;
  }

  private async fireWebhooks(cfg: NotificationSettings, opts: NotifyOptions) {
    const hooks = (cfg.webhooks ?? []).filter((w) => w.enabled && (w.events.includes('*') || w.events.includes(opts.event)));
    for (const hook of hooks) {
      const text = `*${opts.title}*\n${opts.lines.join('\n')}`;
      const body =
        hook.format === 'slack'
          ? { text }
          : hook.format === 'teams'
            ? { type: 'message', text: text.replace(/\*/g, '**') }
            : { event: opts.event, title: opts.title, message: opts.lines.join('\n'), data: opts.data ?? {}, ts: new Date().toISOString() };
      try {
        const res = await fetch(hook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Relay-Event': opts.event },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        await this.logNotification(opts.event, `webhook:${hook.name}`, [], opts.subject, res.ok ? 'sent' : 'failed', res.ok ? undefined : `HTTP ${res.status}`, opts.relatedId);
      } catch (e: any) {
        await this.logNotification(opts.event, `webhook:${hook.name}`, [], opts.subject, 'failed', e.message, opts.relatedId);
      }
    }
  }

  private async logNotification(event: string, channel: string, recipients: string[], subject: string, status: string, error?: string, relatedId?: string) {
    await this.store
      .insert(C.notifications, { id: CryptoService.id(), ts: new Date(), event, channel, recipients, subject, status, error, relatedId })
      .catch(() => undefined);
  }
}
