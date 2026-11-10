import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { Actor } from '../common/util';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  generateRecoveryCodes, generateTotpSecret, hashPassword, otpauthUrl, passwordPolicyErrors, SlidingWindowLimiter, verifyPassword, verifyTotp,
} from './security';
import { Role, SessionUser } from './decorators';

export interface UserRow {
  id: string;
  username: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled' | 'invited';
  passwordHash?: string;
  mustChangePassword?: boolean;
  passwordChangedAt?: Date;
  mfaEnabled?: boolean;
  mfaSecretEnc?: string;
  mfaRecoveryHashes?: string[];
  failedLogins?: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  lastLoginIp?: string;
  inviteTokenHash?: string;
  inviteExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}

interface SessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  csrfHash: string;
  stage: 'mfa' | 'full';
  ip?: string;
  userAgent?: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

export interface IssuedSession {
  token: string;
  csrf: string;
  stage: 'mfa' | 'full';
  expiresAt: Date;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id, username: u.username, email: u.email, name: u.name, role: u.role, status: u.status,
    mfaEnabled: !!u.mfaEnabled, mustChangePassword: !!u.mustChangePassword, lastLoginAt: u.lastLoginAt,
    lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil : undefined,
    inviteExpiresAt: u.status === 'invited' ? u.inviteExpiresAt : undefined,
    createdAt: u.createdAt, updatedAt: u.updatedAt,
  };
}

@Injectable()
export class AuthService {
  private readonly ipLimiter = new SlidingWindowLimiter(60_000);
  private readonly usedTotpSteps = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  private mfaCtx(userId: string) {
    return `user:${userId}:mfa`;
  }

  // ---------- Login ----------
  async login(usernameOrEmail: string, password: string, actor: Actor): Promise<IssuedSession> {
    if (!this.ipLimiter.hit(`login:${actor.ip}`, 20)) {
      throw new HttpException('Too many login attempts. Try again in a minute.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const sec = await this.settings.get('security');
    const ident = usernameOrEmail.trim().toLowerCase();
    const user = await this.store.findOne<UserRow>(C.users, { $or: [{ username: ident }, { email: ident }] });
    const fail = async (reason: string) => {
      await this.audit.log({ ...actor, id: user?.id ?? 'unknown', name: ident }, { action: 'auth.login', outcome: 'failure', details: { reason } });
      throw new UnauthorizedException('Invalid credentials');
    };

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      await verifyPassword(undefined, password);
      await this.audit.log({ ...actor, id: user.id, name: user.username }, { action: 'auth.login', outcome: 'denied', details: { reason: 'locked' } });
      throw new HttpException('Account temporarily locked due to failed sign-in attempts.', HttpStatus.LOCKED);
    }
    const ok = await verifyPassword(user?.passwordHash, password);
    if (!user || !ok) {
      if (user) {
        const failed = (user.failedLogins ?? 0) + 1;
        const lock = failed >= sec.maxFailedLogins;
        await this.store.update(C.users, user.id, {
          failedLogins: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + sec.lockoutMinutes * 60_000) : user.lockedUntil,
        });
        if (lock) {
          await this.notifications.notify({
            event: 'security.alert', subject: `Relay: account ${user.username} locked`, title: 'Account locked',
            lines: [`The account "${user.username}" was locked after ${failed} failed sign-in attempts from ${actor.ip}.`],
            includeAdmins: true, relatedId: user.id,
          });
        }
      }
      return fail(user ? 'bad_password' : 'unknown_user');
    }
    if (user.status !== 'active') return fail(`status_${user.status}`);

    await this.store.update(C.users, user.id, { failedLogins: 0, lockedUntil: null });
    const stage = user.mfaEnabled ? 'mfa' : 'full';
    const session = await this.createSession(user, stage, actor);
    if (stage === 'full') await this.markLogin(user, actor);
    return session;
  }

  private async markLogin(user: UserRow, actor: Actor) {
    await this.store.update(C.users, user.id, { lastLoginAt: new Date(), lastLoginIp: actor.ip });
    await this.audit.log({ ...actor, id: user.id, name: user.username }, { action: 'auth.login', outcome: 'success' });
  }

  async verifyMfaLogin(sessionToken: string, code: string, actor: Actor): Promise<IssuedSession> {
    const session = await this.findSession(sessionToken);
    if (!session || session.stage !== 'mfa') throw new UnauthorizedException('MFA session expired. Sign in again.');
    if (!this.ipLimiter.hit(`mfa:${session.id}`, 6)) throw new HttpException('Too many attempts', HttpStatus.TOO_MANY_REQUESTS);
    const user = await this.store.findById<UserRow>(C.users, session.userId);
    if (!user || user.status !== 'active') throw new UnauthorizedException();
    const valid = await this.checkMfaCode(user, code);
    if (!valid) {
      await this.audit.log({ ...actor, id: user.id, name: user.username }, { action: 'auth.mfa', outcome: 'failure' });
      throw new UnauthorizedException('Invalid verification code');
    }
    await this.revokeSession(session.id);
    const full = await this.createSession(user, 'full', actor);
    await this.markLogin(user, actor);
    return full;
  }

  /** Accepts a TOTP code (with replay protection) or a single-use recovery code. */
  private async checkMfaCode(user: UserRow, code: string): Promise<boolean> {
    const clean = code.replace(/\s/g, '');
    if (user.mfaSecretEnc && /^\d{6}$/.test(clean)) {
      const secret = this.crypto.decrypt(user.mfaSecretEnc, this.mfaCtx(user.id));
      const step = verifyTotp(secret, clean);
      if (step === null) return false;
      if ((this.usedTotpSteps.get(user.id) ?? -1) >= step) return false;
      this.usedTotpSteps.set(user.id, step);
      return true;
    }
    const hashes = user.mfaRecoveryHashes ?? [];
    const current = this.crypto.hmac(`recovery:${clean.toUpperCase()}`);
    const h = hashes.includes(current) ? current : this.crypto.hmacPrevious(`recovery:${clean.toUpperCase()}`);
    if (h && hashes.includes(h)) {
      await this.store.update(C.users, user.id, { mfaRecoveryHashes: hashes.filter((x) => x !== h) });
      return true;
    }
    return false;
  }

  // ---------- Sessions ----------
  private async createSession(user: UserRow, stage: 'mfa' | 'full', actor: Actor): Promise<IssuedSession> {
    const sec = await this.settings.get('security');
    const token = CryptoService.randomToken(32);
    const csrf = CryptoService.randomToken(24);
    const expiresAt = new Date(Date.now() + (stage === 'mfa' ? 5 * 60_000 : sec.sessionAbsoluteHours * 3600_000));
    await this.store.insert<SessionRow>(C.sessions, {
      id: CryptoService.id(), userId: user.id, tokenHash: this.crypto.hmac(`session:${token}`), csrfHash: this.crypto.hmac(`csrf:${csrf}`),
      stage, ip: actor.ip, userAgent: actor.userAgent?.slice(0, 300), createdAt: new Date(), lastSeenAt: new Date(), expiresAt,
    });
    return { token, csrf, stage, expiresAt };
  }

  private async findSession(token: string): Promise<SessionRow | null> {
    if (!token || token.length > 100) return null;
    const s = await this.store.findOne<SessionRow>(C.sessions, { tokenHash: this.crypto.hmac(`session:${token}`) });
    if (!s || s.revokedAt || s.expiresAt < new Date()) return null;
    return s;
  }

  /** Validates a session cookie; returns the user context or null. */
  async authenticate(token: string, csrf: string | undefined, needCsrf: boolean): Promise<SessionUser | null> {
    const s = await this.findSession(token);
    if (!s || s.stage !== 'full') return null;
    const sec = await this.settings.get('security');
    if (Date.now() - new Date(s.lastSeenAt).getTime() > sec.sessionIdleMinutes * 60_000) {
      await this.revokeSession(s.id);
      return null;
    }
    if (needCsrf && (!csrf || !CryptoService.safeEqual(this.crypto.hmac(`csrf:${csrf}`), s.csrfHash))) {
      throw new ForbiddenException('CSRF token missing or invalid');
    }
    const user = await this.store.findById<UserRow>(C.users, s.userId);
    if (!user || user.status !== 'active') return null;
    if (Date.now() - new Date(s.lastSeenAt).getTime() > 60_000) await this.store.update(C.sessions, s.id, { lastSeenAt: new Date() });
    return {
      id: user.id, username: user.username, email: user.email, name: user.name, role: user.role, sessionId: s.id,
      mustChangePassword: !!user.mustChangePassword, mfaEnabled: !!user.mfaEnabled,
      mfaEnrollmentRequired: sec.requireMfa && !user.mfaEnabled,
    };
  }

  async logout(token: string, actor: Actor) {
    const s = await this.findSession(token);
    if (s) {
      await this.revokeSession(s.id);
      await this.audit.log(actor, { action: 'auth.logout' });
    }
  }

  async revokeSession(id: string) {
    await this.store.update(C.sessions, id, { revokedAt: new Date() });
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string) {
    const sessions = await this.store.find<SessionRow>(C.sessions, { userId, revokedAt: { $exists: false } });
    for (const s of sessions) if (s.id !== exceptSessionId) await this.revokeSession(s.id);
  }

  async listSessions(userId: string) {
    const rows = await this.store.find<SessionRow>(C.sessions, { userId, stage: 'full', revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }, { sort: { lastSeenAt: -1 } });
    return rows.map((s) => ({ id: s.id, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt }));
  }

  // ---------- Passwords ----------
  async validatePassword(password: string, username?: string) {
    const sec = await this.settings.get('security');
    const errors = passwordPolicyErrors(password, sec.passwordMinLength, username);
    if (errors.length) throw new BadRequestException({ message: 'Password does not meet policy', issues: errors.map((message) => ({ path: 'password', message })) });
  }

  async changePassword(user: SessionUser, current: string, next: string, actor: Actor) {
    const row = await this.store.findById<UserRow>(C.users, user.id);
    if (!row || !(await verifyPassword(row.passwordHash, current))) {
      await this.audit.log(actor, { action: 'auth.password_change', outcome: 'failure' });
      throw new BadRequestException('Current password is incorrect');
    }
    if (current === next) throw new BadRequestException('New password must differ from the current one');
    await this.validatePassword(next, row.username);
    await this.store.update(C.users, user.id, { passwordHash: await hashPassword(next), mustChangePassword: false, passwordChangedAt: new Date(), updatedAt: new Date() });
    await this.revokeAllSessions(user.id, user.sessionId);
    await this.audit.log(actor, { action: 'auth.password_change', resourceType: 'user', resourceId: user.id });
  }

  // ---------- Invitations ----------
  async inviteInfo(token: string) {
    const user = await this.store.findOne<UserRow>(C.users, { inviteTokenHash: this.crypto.hmac(`invite:${token}`) });
    if (!user || !user.inviteExpiresAt || user.inviteExpiresAt < new Date()) throw new BadRequestException('Invitation is invalid or has expired');
    return { username: user.username, email: user.email, name: user.name };
  }

  async acceptInvite(token: string, password: string, actor: Actor) {
    if (!this.ipLimiter.hit(`invite:${actor.ip}`, 10)) throw new HttpException('Too many attempts', HttpStatus.TOO_MANY_REQUESTS);
    const user = await this.store.findOne<UserRow>(C.users, { inviteTokenHash: this.crypto.hmac(`invite:${token}`) });
    if (!user || !user.inviteExpiresAt || user.inviteExpiresAt < new Date()) throw new BadRequestException('Invitation is invalid or has expired');
    await this.validatePassword(password, user.username);
    await this.store.update(C.users, user.id, {
      passwordHash: await hashPassword(password), status: user.status === 'invited' ? 'active' : user.status, inviteTokenHash: null, inviteExpiresAt: null,
      mustChangePassword: false, passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null, updatedAt: new Date(),
    });
    await this.revokeAllSessions(user.id);
    await this.audit.log({ ...actor, id: user.id, name: user.username }, { action: 'auth.invite_accepted', resourceType: 'user', resourceId: user.id });
  }

  // ---------- MFA enrolment ----------
  async mfaSetup(user: SessionUser) {
    if (user.mfaEnabled) throw new BadRequestException('MFA already enabled. Disable it first to re-enrol.');
    const secret = generateTotpSecret();
    const url = otpauthUrl(secret, user.username);
    // Stored but not enabled until verified.
    await this.store.update(C.users, user.id, { mfaSecretEnc: this.crypto.encrypt(secret, this.mfaCtx(user.id)) });
    return { secret, otpauthUrl: url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  }

  async mfaEnable(user: SessionUser, code: string, actor: Actor) {
    const row = await this.store.findById<UserRow>(C.users, user.id);
    if (!row?.mfaSecretEnc) throw new BadRequestException('Start MFA setup first');
    const secret = this.crypto.decrypt(row.mfaSecretEnc, this.mfaCtx(user.id));
    if (verifyTotp(secret, code.trim()) === null) throw new BadRequestException('Invalid verification code');
    const codes = generateRecoveryCodes();
    await this.store.update(C.users, user.id, { mfaEnabled: true, mfaRecoveryHashes: codes.map((c) => this.crypto.hmac(`recovery:${c}`)), updatedAt: new Date() });
    await this.audit.log(actor, { action: 'auth.mfa_enabled', resourceType: 'user', resourceId: user.id });
    return { recoveryCodes: codes };
  }

  async mfaDisable(user: SessionUser, password: string, code: string, actor: Actor) {
    const row = await this.store.findById<UserRow>(C.users, user.id);
    if (!row || !(await verifyPassword(row.passwordHash, password)) || !(await this.checkMfaCode(row, code))) {
      await this.audit.log(actor, { action: 'auth.mfa_disabled', outcome: 'failure' });
      throw new BadRequestException('Password or code is incorrect');
    }
    const sec = await this.settings.get('security');
    if (sec.requireMfa) throw new ForbiddenException('MFA is required by the security policy');
    await this.store.update(C.users, user.id, { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: null, updatedAt: new Date() });
    await this.audit.log(actor, { action: 'auth.mfa_disabled', resourceType: 'user', resourceId: user.id });
  }
}
