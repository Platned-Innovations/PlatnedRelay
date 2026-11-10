import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { ALLOW_PARTIAL_KEY, PUBLIC_KEY, Role, ROLE_KEY, ROLE_RANK } from './decorators';
import { SettingsService } from '../settings/settings.service';
import { ipAllowed } from './security';
import { clientIp } from '../common/util';

export const SESSION_COOKIE = 'relay_sid';
export const CSRF_COOKIE = 'relay_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Global guard for the admin API (/api/admin/**).
 * - Enforces the admin IP allowlist (also for public auth endpoints).
 * - Validates the opaque, DB-backed session cookie (idle + absolute timeouts).
 * - Enforces double-submit CSRF tokens bound to the session on mutating requests.
 * - Enforces role-based access (viewer < admin < owner).
 * - Restricts partially-authenticated sessions (password change / MFA enrolment pending).
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService, private readonly settings: SettingsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: any; actor?: any }>();
    const isAdminApi = req.path.startsWith('/api/admin');
    const ip = clientIp(req);
    req.actor = { type: 'user', id: 'anonymous', name: 'anonymous', ip, userAgent: req.headers['user-agent'] };

    if (isAdminApi) {
      const sec = await this.settings.get('security');
      if (!ipAllowed(ip, sec.adminIpAllowlist)) throw new ForbiddenException('Admin access is not allowed from this network');
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic || !isAdminApi) return true;

    const token = (req as any).cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Not signed in');
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const csrf = req.headers[CSRF_HEADER] as string | undefined;
    const user = await this.auth.authenticate(token, csrf, mutating);
    if (!user) throw new UnauthorizedException('Session expired');
    req.user = user;
    req.actor = { type: 'user', id: user.id, name: user.username, role: user.role, ip, userAgent: req.headers['user-agent'] };

    const allowPartial = this.reflector.getAllAndOverride<boolean>(ALLOW_PARTIAL_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!allowPartial && (user.mustChangePassword || user.mfaEnrollmentRequired)) {
      throw new ForbiddenException({ message: user.mustChangePassword ? 'Password change required' : 'MFA enrolment required', code: user.mustChangePassword ? 'PASSWORD_CHANGE_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED' });
    }

    const required: Role = this.reflector.getAllAndOverride<Role>(ROLE_KEY, [ctx.getHandler(), ctx.getClass()]) ?? (mutating ? 'admin' : 'viewer');
    if (ROLE_RANK[user.role] < ROLE_RANK[required]) throw new ForbiddenException(`Requires ${required} role`);
    return true;
  }
}
