import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { GatewayError } from '../gateway/router';

/**
 * Formats errors consistently and never leaks stack traces or internal details.
 * /v1 routes use the OpenAI error envelope so SDKs surface messages correctly.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const isGateway = req.path.startsWith('/v1');
    let status = 500;
    let message = 'Internal server error';
    let type = 'api_error';
    let code = 'internal_error';
    let extra: Record<string, unknown> = {};

    if (exception instanceof GatewayError) {
      status = exception.status;
      message = exception.message;
      type = exception.type;
      code = exception.code;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') message = body;
      else {
        const b = body as Record<string, any>;
        message = Array.isArray(b.message) ? b.message.join('; ') : b.message ?? exception.message;
        if (b.issues) extra.issues = b.issues;
        if (b.code) code = b.code;
      }
      type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
      if (code === 'internal_error') {
        const byStatus: Record<number, string> = { 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 413: 'payload_too_large', 423: 'locked', 429: 'rate_limited' };
        code = byStatus[status] ?? (status >= 500 ? 'internal_error' : 'bad_request');
      }
    } else if ((exception as any)?.type === 'entity.parse.failed') {
      status = 400;
      message = 'Malformed JSON body';
      type = 'invalid_request_error';
      code = 'invalid_json';
    } else if ((exception as any)?.type === 'entity.too.large') {
      status = 413;
      message = 'Request body too large';
      type = 'invalid_request_error';
      code = 'payload_too_large';
    } else {
      this.logger.error(`Unhandled error on ${req.method} ${req.path}: ${(exception as Error)?.stack ?? exception}`);
    }

    if (status === 429) res.setHeader('Retry-After', '10');
    if (isGateway) res.status(status).json({ error: { message, type, code, param: null } });
    else res.status(status).json({ statusCode: status, message, code, ...extra });
  }
}
