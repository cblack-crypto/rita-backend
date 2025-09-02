// src/server.ts
import fastify, { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import { z } from 'zod';

import { config } from './config.js';
import { DatabaseService } from './services/DatabaseService.js';
import { MetricsService } from './services/MetricsService.js';
import { AuthService } from './services/AuthService.js';
import { SecurityUtils } from './utils/SecurityUtils.js';

class RitaServer {
  private app: FastifyInstance;
  public db: DatabaseService;
  private metrics: MetricsService;

  constructor() {
    this.app = fastify({
      logger: false,
      trustProxy: true,
      bodyLimit: 10 * 1024 * 1024, // 10MB
      requestTimeout: 30_000,
    });

    this.db = new DatabaseService();
    this.metrics = new MetricsService(this.db);

    this.setupMiddleware();
    this.setupRoutes();
    this.setupHealth();
  }

  private setupMiddleware() {
    // Security headers (loosen CSP in dev so docs/tools work)
    this.app.register(helmet, {
      contentSecurityPolicy: config.NODE_ENV === 'production' ? undefined : false,
    });

    // CORS
    this.app.register(cors, {
      origin: config.NODE_ENV === 'production' ? ['https://app.rita.example.com'] : true,
      credentials: true,
    });

    // Rate limiting
    this.app.register(rateLimit, {
      max: 100,
      timeWindow: '1 minute',
    });

    // Raw body for HMAC verification (adds Buffer on request.rawBody)
    this.app.register(rawBody, { field: 'rawBody', global: true, runFirst: true });

    // Dev-friendly auth: use x-dev-user if present (skips Cognito in dev)
    this.app.addHook('preHandler', async (request, reply) => {
      const publicPaths = ['/health', '/ready', '/api/v1/metrics'];
      if (publicPaths.some((p) => request.url.startsWith(p))) return;

      const devUser = request.headers['x-dev-user'] as string | undefined;
      try {
        const user = await AuthService.authenticateUser(request.headers.authorization, devUser);
        (request as any).user = user;
      } catch (err: any) {
        reply.code(401).send({ error: err?.message ?? 'unauthorized' });
      }
    });

    // Basic request logging (pino is already used elsewhere; keep this light)
    this.app.addHook('onRequest', async (req) => {
      console.log(
        JSON.stringify({
          level: 30,
          time: Date.now(),
          method: req.method,
          url: req.url,
          ua: (req.headers['user-agent'] || '').toString().slice(0, 120),
          ip: req.ip,
        })
      );
    });
  }

  private setupRoutes() {
    // Signed FL weight upload
    this.app.post('/api/v1/fl/weights', async (request, reply) => {
      try {
        const user = (request as any).user;
        if (!user) return reply.code(401).send({ error: 'unauthorized' });

        // === HMAC over the exact raw payload ===
        const raw = (request as any).rawBody as Buffer | undefined;
        if (!raw) return reply.code(400).send({ error: 'missing raw body' });
        if (raw.length > 2 * 1024 * 1024) return reply.code(413).send({ error: 'payload too large' });

        const signature = request.headers['x-signature'] as string | undefined;
        if (!signature) return reply.code(403).send({ error: 'missing signature' });

        const rawStr = raw.toString('utf8');
        if (!SecurityUtils.validateHMAC(rawStr, signature, config.DEVICE_HMAC_SECRET)) {
          return reply.code(403).send({ error: 'invalid signature' });
        }

        // === Parse & validate ===
        const body = z
          .object({
            siteId: z.string().min(1).max(50).regex(/^[a-zA-Z0-9_-]+$/),
            modelName: z.string().min(1).max(100),
            weights: z.record(z.string(), z.array(z.number().finite())),
            dataSampleCount: z.number().positive(),
            dataQuality: z.number().min(0).max(1).default(1.0),
            timestamp: z.number().positive(),
            nonce: z.string().uuid(),
          })
          .parse(request.body);

        // Fresh timestamp window (±5 minutes)
        if (!SecurityUtils.isRecentTimestamp(body.timestamp)) {
          return reply.code(400).send({ error: 'stale or future timestamp' });
        }

        // === Nonce replay lock (5 minutes) ===
        const nonceKey = `fl:{${body.modelName}}:nonce:${body.siteId}:${body.nonce}`;
        const ok = await this.db.client.set(nonceKey, '1', 'PX', 5 * 60_000, 'NX');
        if (!ok) return reply.code(409).send({ error: 'replay detected' });

        // === Persist pending update (1 hour TTL) ===
        const ts = Date.now();
        const updateKey = `fl:{${body.modelName}}:pending:${body.modelName}:${body.siteId}:${ts}`;
        const doc = { ...body, receivedAt: new Date().toISOString(), uploadedBy: (user as any).sub ?? 'dev' };
        await this.db.client.setex(updateKey, 3600, JSON.stringify(doc));

        // Receipt
        return reply.send({
          status: 'uploaded',
          key: updateKey,
          siteId: body.siteId,
          modelName: body.modelName,
          sizeBytes: raw.length,
          receivedAt: doc.receivedAt,
        });
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? 'bad request' });
      }
    });

    // System metrics (public for monitoring)
    this.app.get('/api/v1/metrics', async (_req, reply) => {
      try {
        const metrics = await this.metrics.getSystemMetrics();
        reply.send(metrics);
      } catch (e: any) {
        reply.code(500).send({ error: e?.message ?? 'metrics failed' });
      }
    });
  }

  private setupHealth() {
    // Liveness
    this.app.get('/health', async (_req, reply) => {
      try {
        await this.db.client.ping();
        const mem = process.memoryUsage();
        reply.send({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          memory: {
            usedMB: Math.round(mem.heapUsed / 1024 / 1024),
            totalMB: Math.round(mem.heapTotal / 1024 / 1024),
          },
          services: { redis: 'healthy' },
        });
      } catch (e: any) {
        reply.code(503).send({ status: 'unhealthy', error: e?.message ?? 'redis failed' });
      }
    });

    // Readiness
    this.app.get('/ready', async (_req, reply) => {
      reply.send({ status: 'ready' });
    });
  }

  async start() {
    await this.app.listen({ host: '0.0.0.0', port: Number(config.PORT) || 3000 });
    console.log(
      JSON.stringify({
        level: 30,
        time: Date.now(),
        port: Number(config.PORT) || 3000,
        env: config.NODE_ENV,
        msg: 'Rita server started',
      })
    );
  }
}

const server = new RitaServer();

// auto-start unless under tests
if (process.env.NODE_ENV !== 'test') {
  server.start().catch((err) => {
    console.error(JSON.stringify({ level: 50, time: Date.now(), msg: 'startup failed', err: err?.message }));
    process.exit(1);
  });
}

export default server;
