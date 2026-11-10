import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { Actor, ZodPipe } from '../common/util';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthService, publicUser, UserRow } from '../auth/auth.service';
import { CurrentActor, CurrentUser, MinRole, Role, SessionUser } from '../auth/decorators';

const RoleEnum = z.enum(['owner', 'admin', 'viewer']);
const CreateSchema = z.object({
  username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, dot, dash and underscore only'),
  email: z.string().email().max(200),
  name: z.string().min(1).max(120),
  role: RoleEnum,
  sendEmail: z.boolean().default(true),
});
const UpdateSchema = z.object({ email: z.string().email().max(200).optional(), name: z.string().min(1).max(120).optional(), role: RoleEnum.optional() });

@Injectable()
export class UsersService {
  constructor(
    private readonly store: Store,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly auth: AuthService,
  ) {}

  async list() {
    const rows = await this.store.find<UserRow>(C.users, {}, { sort: { createdAt: 1 } });
    return rows.map(publicUser);
  }

  private async get(id: string) {
    const u = await this.store.findById<UserRow>(C.users, id);
    if (!u) throw new NotFoundException('User not found');
    return u;
  }

  private assertCanManage(actor: SessionUser, target: { role: Role }, newRole?: Role) {
    if ((target.role === 'owner' || newRole === 'owner') && actor.role !== 'owner') throw new ForbiddenException('Only owners can manage owner accounts');
  }

  private async ownersCount() {
    return this.store.count(C.users, { role: 'owner', status: 'active' });
  }

  private async issueInvite(user: UserRow, kind: 'invite' | 'reset', sendEmail: boolean, actor: Actor) {
    const sec = await this.settings.get('security');
    const gw = await this.settings.get('gateway');
    const token = CryptoService.randomToken(32);
    const expires = new Date(Date.now() + sec.inviteExpiryHours * 3600_000);
    await this.store.update(C.users, user.id, { inviteTokenHash: this.crypto.hmac(`invite:${token}`), inviteExpiresAt: expires, updatedAt: new Date() });
    const base = gw.publicBaseUrl?.replace(/\/$/, '') || '';
    const url = `${base}/invite/${token}`;
    if (sendEmail) {
      await this.notifications.notify({
        event: kind === 'invite' ? 'user.onboarding' : 'user.password_reset',
        force: true,
        to: [user.email],
        subject: kind === 'invite' ? 'You have been invited to Relay LLM Gateway' : 'Reset your Relay password',
        title: kind === 'invite' ? `Welcome to Relay, ${user.name}` : 'Password reset',
        lines:
          kind === 'invite'
            ? [`${actor.name} invited you to the Relay LLM Gateway admin console as ${user.role}.`, `Username: ${user.username}`, `This link expires on ${expires.toUTCString()}.`]
            : [`A password reset was requested by ${actor.name}.`, `This link expires on ${expires.toUTCString()}.`],
        action: { label: kind === 'invite' ? 'Set your password' : 'Reset password', url },
        relatedId: user.id,
      });
    }
    return { inviteUrl: url, expiresAt: expires };
  }

  async create(input: z.infer<typeof CreateSchema>, actorUser: SessionUser, actor: Actor) {
    this.assertCanManage(actorUser, { role: input.role }, input.role);
    const username = input.username.toLowerCase();
    const email = input.email.toLowerCase();
    if (await this.store.findOne(C.users, { $or: [{ username }, { email }] })) throw new BadRequestException('Username or email already exists');
    const user: UserRow = {
      id: CryptoService.id(), username, email, name: input.name, role: input.role, status: 'invited', mustChangePassword: false,
      mfaEnabled: false, failedLogins: 0, createdAt: new Date(), updatedAt: new Date(), createdBy: actor.id,
    };
    await this.store.insert(C.users, user);
    const invite = await this.issueInvite(user, 'invite', input.sendEmail, actor);
    await this.audit.log(actor, { action: 'user.created', resourceType: 'user', resourceId: user.id, details: { username, email, role: input.role } });
    return { user: publicUser(user), ...invite };
  }

  async update(id: string, patch: z.infer<typeof UpdateSchema>, actorUser: SessionUser, actor: Actor) {
    const user = await this.get(id);
    this.assertCanManage(actorUser, user, patch.role);
    if (patch.role && user.role === 'owner' && patch.role !== 'owner' && (await this.ownersCount()) <= 1) throw new BadRequestException('Cannot demote the last owner');
    if (patch.role && id === actorUser.id && patch.role !== user.role) throw new BadRequestException('You cannot change your own role');
    if (patch.email) {
      patch.email = patch.email.toLowerCase();
      const clash = await this.store.findOne<UserRow>(C.users, { email: patch.email });
      if (clash && clash.id !== id) throw new BadRequestException('Email already in use');
    }
    const updated = await this.store.update<UserRow>(C.users, id, { ...patch, updatedAt: new Date() });
    if (patch.role && patch.role !== user.role) await this.auth.revokeAllSessions(id);
    await this.audit.log(actor, { action: 'user.updated', resourceType: 'user', resourceId: id, details: { before: { email: user.email, name: user.name, role: user.role }, after: patch } });
    return publicUser(updated!);
  }

  async setStatus(id: string, status: 'active' | 'disabled', actorUser: SessionUser, actor: Actor) {
    const user = await this.get(id);
    this.assertCanManage(actorUser, user);
    if (id === actorUser.id) throw new BadRequestException('You cannot change your own status');
    if (status === 'disabled' && user.role === 'owner' && (await this.ownersCount()) <= 1) throw new BadRequestException('Cannot disable the last owner');
    if (status === 'active' && user.status === 'invited') throw new BadRequestException('User has not accepted the invitation yet');
    await this.store.update(C.users, id, { status, updatedAt: new Date() });
    if (status === 'disabled') await this.auth.revokeAllSessions(id);
    await this.audit.log(actor, { action: status === 'disabled' ? 'user.disabled' : 'user.enabled', resourceType: 'user', resourceId: id });
    return { ok: true };
  }

  async resetAccess(id: string, sendEmail: boolean, actorUser: SessionUser, actor: Actor) {
    const user = await this.get(id);
    this.assertCanManage(actorUser, user);
    const res = await this.issueInvite(user, user.status === 'invited' ? 'invite' : 'reset', sendEmail, actor);
    await this.audit.log(actor, { action: user.status === 'invited' ? 'user.invite_resent' : 'user.password_reset_issued', resourceType: 'user', resourceId: id });
    return res;
  }

  async resetMfa(id: string, actorUser: SessionUser, actor: Actor) {
    const user = await this.get(id);
    this.assertCanManage(actorUser, user);
    await this.store.update(C.users, id, { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: null, updatedAt: new Date() });
    await this.auth.revokeAllSessions(id);
    await this.audit.log(actor, { action: 'user.mfa_reset', resourceType: 'user', resourceId: id });
    return { ok: true };
  }

  async unlock(id: string, actor: Actor) {
    await this.get(id);
    await this.store.update(C.users, id, { lockedUntil: null, failedLogins: 0 });
    await this.audit.log(actor, { action: 'user.unlocked', resourceType: 'user', resourceId: id });
    return { ok: true };
  }
}

@Controller('api/admin/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  create(@Body(new ZodPipe(CreateSchema)) body: z.infer<typeof CreateSchema>, @CurrentUser() user: SessionUser, @CurrentActor() actor: Actor) {
    return this.users.create(body, user, actor);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body(new ZodPipe(UpdateSchema)) body: z.infer<typeof UpdateSchema>, @CurrentUser() user: SessionUser, @CurrentActor() actor: Actor) {
    return this.users.update(id, body, user, actor);
  }

  @Post(':id/disable')
  disable(@Param('id') id: string, @CurrentUser() user: SessionUser, @CurrentActor() actor: Actor) {
    return this.users.setStatus(id, 'disabled', user, actor);
  }

  @Post(':id/enable')
  enable(@Param('id') id: string, @CurrentUser() user: SessionUser, @CurrentActor() actor: Actor) {
    return this.users.setStatus(id, 'active', user, actor);
  }

  @Post(':id/reset-access')
  reset(@Param('id') id: string, @Body() body: { sendEmail?: boolean }, @CurrentUser() user: SessionUser, @CurrentActor() actor: Actor) {
    return this.users.resetAccess(id, body?.sendEmail !== false, user, actor);
  }

  @MinRole('owner')
  @Post(':id/reset-mfa')
  resetMfa(@Param('id') id: string, @CurrentUser() user: SessionUser, @CurrentActor() actor: Actor) {
    return this.users.resetMfa(id, user, actor);
  }

  @Post(':id/unlock')
  unlock(@Param('id') id: string, @CurrentActor() actor: Actor) {
    return this.users.unlock(id, actor);
  }
}
