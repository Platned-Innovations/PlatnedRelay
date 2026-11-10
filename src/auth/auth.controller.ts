import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService, IssuedSession } from './auth.service';
import { AllowPartialSession, CurrentActor, CurrentUser, MinRole, Public, SessionUser } from './decorators';
import { CSRF_COOKIE, SESSION_COOKIE } from './auth.guard';
import { Actor, ZodPipe } from '../common/util';
import { ForbiddenException } from '@nestjs/common';

const LoginSchema = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(256) });
const CodeSchema = z.object({ code: z.string().min(6).max(20) });
const ChangePwSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) });
const AcceptSchema = z.object({ token: z.string().min(10).max(200), password: z.string().min(1).max(256) });
const DisableMfaSchema = z.object({ password: z.string().min(1).max(256), code: z.string().min(6).max(20) });

@Controller('api/admin/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private setCookies(req: Request, res: Response, s: IssuedSession) {
    const secure = req.secure || process.env.NODE_ENV === 'production';
    const base = { secure, sameSite: 'strict' as const, path: '/', expires: s.expiresAt };
    res.cookie(SESSION_COOKIE, s.token, { ...base, httpOnly: true });
    res.cookie(CSRF_COOKIE, s.csrf, { ...base, httpOnly: false });
  }

  private clearCookies(res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>, @CurrentActor() actor: Actor, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.login(body.username, body.password, actor);
    this.setCookies(req, res, s);
    return { mfaRequired: s.stage === 'mfa' };
  }

  @Public()
  @Post('mfa')
  @HttpCode(200)
  async mfa(@Body(new ZodPipe(CodeSchema)) body: z.infer<typeof CodeSchema>, @CurrentActor() actor: Actor, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.verifyMfaLogin(req.cookies?.[SESSION_COOKIE], body.code, actor);
    this.setCookies(req, res, s);
    return { ok: true };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[SESSION_COOKIE], actor);
    this.clearCookies(res);
    return { ok: true };
  }

  @AllowPartialSession()
  @MinRole('viewer')
  @Get('me')
  me(@CurrentUser() user: SessionUser) {
    const { sessionId, ...rest } = user;
    return rest;
  }

  @AllowPartialSession()
  @MinRole('viewer')
  @Post('change-password')
  @HttpCode(200)
  async changePassword(@Body(new ZodPipe(ChangePwSchema)) body: z.infer<typeof ChangePwSchema>, @CurrentUser() user: SessionUser, @CurrentActor() actor: Actor) {
    await this.auth.changePassword(user, body.currentPassword, body.newPassword, actor);
    return { ok: true };
  }

  @AllowPartialSession()
  @MinRole('viewer')
  @Post('mfa/setup')
  @HttpCode(200)
  mfaSetup(@CurrentUser() user: SessionUser) {
    if (user.mustChangePassword) throw new ForbiddenException('Change your password first');
    return this.auth.mfaSetup(user);
  }

  @AllowPartialSession()
  @MinRole('viewer')
  @Post('mfa/enable')
  @HttpCode(200)
  mfaEnable(@Body(new ZodPipe(CodeSchema)) body: z.infer<typeof CodeSchema>, @CurrentUser() user: SessionUser, @CurrentActor() actor: Actor) {
    return this.auth.mfaEnable(user, body.code, actor);
  }

  @MinRole('viewer')
  @Post('mfa/disable')
  @HttpCode(200)
  async mfaDisable(@Body(new ZodPipe(DisableMfaSchema)) body: z.infer<typeof DisableMfaSchema>, @CurrentUser() user: SessionUser, @CurrentActor() actor: Actor) {
    await this.auth.mfaDisable(user, body.password, body.code, actor);
    return { ok: true };
  }

  @MinRole('viewer')
  @Get('sessions')
  sessions(@CurrentUser() user: SessionUser) {
    return this.auth.listSessions(user.id).then((rows) => rows.map((r) => ({ ...r, current: r.id === user.sessionId })));
  }

  @MinRole('viewer')
  @Delete('sessions/:id')
  async revokeSession(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    const mine = await this.auth.listSessions(user.id);
    if (mine.some((s) => s.id === id)) await this.auth.revokeSession(id);
    return { ok: true };
  }

  @Public()
  @Get('invite/:token')
  invite(@Param('token') token: string) {
    return this.auth.inviteInfo(token);
  }

  @Public()
  @Post('invite/accept')
  @HttpCode(200)
  async accept(@Body(new ZodPipe(AcceptSchema)) body: z.infer<typeof AcceptSchema>, @CurrentActor() actor: Actor) {
    await this.auth.acceptInvite(body.token, body.password, actor);
    return { ok: true };
  }
}
