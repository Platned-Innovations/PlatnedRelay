import 'reflect-metadata';
import cluster from 'node:cluster';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { json, static as serveStatic, type NextFunction, type Request, type Response } from 'express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { startBusRelay } from './common/bus';

async function bootstrap() {
  const env = loadEnv();
  const logger = new Logger('Relay');
  const verbose = process.env.LOG_LEVEL === 'debug';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: verbose ? ['error', 'warn', 'log', 'debug'] : ['error', 'warn'] });

  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  if (env.trustProxy) app.set('trust proxy', /^\d+$/.test(env.trustProxy) ? Number(env.trustProxy) : env.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: { maxAge: 31536000, includeSubDomains: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(cookieParser());
  // Gateway payloads can be large (long contexts, images); admin payloads are small.
  app.use('/v1', json({ limit: '25mb' }));
  app.use(json({ limit: '1mb' }));
  app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableShutdownHooks();

  // Admin UI (built React app) with SPA fallback.
  const webDir = [path.join(__dirname, '..', 'web', 'dist'), path.join(process.cwd(), 'web', 'dist')].find((d) => fs.existsSync(path.join(d, 'index.html')));
  if (webDir) {
    express.use(serveStatic(webDir, { index: false, maxAge: '1h', setHeaders: (res, file) => file.endsWith('.html') && res.setHeader('Cache-Control', 'no-store') }));
    const indexHtml = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
    express.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/v1') || req.path.startsWith('/health')) return next();
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(indexHtml);
    });
  } else {
    logger.warn('Admin UI build not found (web/dist). Run "npm run build:web".');
  }

  await app.listen(env.port, '0.0.0.0');
  const server = app.getHttpServer();
  // Long-lived LLM streams: no request timeout, generous keep-alive behind load balancers.
  server.requestTimeout = 0;
  server.headersTimeout = 66_000;
  server.keepAliveTimeout = 65_000;
  console.log(`Relay listening on :${env.port} (db=${env.dbType}, pid=${process.pid})`);
}

/**
 * Optional multi-process mode: RELAY_WORKERS=<n|auto> forks n workers sharing the
 * port so one container can use every CPU core. Horizontal scaling (more
 * containers / Azure instances) works with or without it.
 */
function start() {
  const raw = process.env.RELAY_WORKERS;
  const workers = raw === 'auto' ? os.availableParallelism() : Number(raw || 1);
  if (workers > 1 && cluster.isPrimary) {
    loadEnv();
    console.log(`Relay primary ${process.pid} starting ${workers} workers`);
    startBusRelay();
    for (let i = 0; i < workers; i++) cluster.fork();
    cluster.on('exit', (w, code) => {
      console.error(`Worker ${w.process.pid} exited (${code}); restarting`);
      setTimeout(() => cluster.fork(), 1000);
    });
    return;
  }
  bootstrap().catch((e) => {
    console.error(`Fatal startup error: ${e?.message ?? e}`);
    process.exit(1);
  });
}

start();
