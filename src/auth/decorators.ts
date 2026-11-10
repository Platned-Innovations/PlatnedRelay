import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Actor } from '../common/util';

export type Role = 'owner' | 'admin' | 'viewer';
export const ROLE_RANK: Record<Role, number> = { viewer: 1, admin: 2, owner: 3 };

export const PUBLIC_KEY = 'relay:public';
export const ROLE_KEY = 'relay:role';
export const ALLOW_PARTIAL_KEY = 'relay:allowPartial';

/** Route needs no admin session (login, invite acceptance, health, gateway). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Minimum role required. Defaults: GET -> viewer, mutations -> admin. */
export const MinRole = (role: Role) => SetMetadata(ROLE_KEY, role);
/** Route reachable while the session still must change password / enrol MFA. */
export const AllowPartialSession = () => SetMetadata(ALLOW_PARTIAL_KEY, true);

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  mfaEnrollmentRequired: boolean;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionUser => ctx.switchToHttp().getRequest().user);
export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => ctx.switchToHttp().getRequest().actor);
