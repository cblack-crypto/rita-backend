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
import { StreamingFLAggregator } from './services/StreamingFLAggregator.js';

class RitaServer {
  private app: FastifyInstance;
  public db: DatabaseService;
  private metrics: MetricsService;
  private flAggregator: StreamingFLAggregator;

  constructor() {
    this.app = fastify({
      logger: false,
      trustProxy: true,
      bodyLimit: 10 * 1024 * 1024,
      requestTimeout: 30_000,
    });

    this.db = new DatabaseService();
    this.metrics = new MetricsService(this.db);
    this.flAggregator = new StreamingFLAggregator();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupHealth();
  }

  private setupMiddleware() {
    this.app.register(helmet, {
      contentSecurityPolicy: config.NODE_ENV === 'production' ? undefined : false,
    });

    this.app.register(cors, {
      origin: config.NODE_ENV === 'production' ? ['https://app.rita.example.com'] : true,
      credentials: true,
    });

    this.app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

    this.app.register(rawBody, {
      field: 'rawBody',
      global: true,
      runFirst: true,
      encoding: false,
    });

    this.app.addHook('preHandler', async (request, reply) => {
      const publicPaths = ['/health', '/ready', '/api/v1/metrics', '/api/v1/fl/model/'];
      if (publicPaths.some((p) => request.url.startsWith(p))) return;

      const devUser = request.headers['x-dev-user'] as string | undefined;
      if (devUser && config.NODE_ENV !== 'production') {
        (request as any).user = { sub: devUser, 'cognito:groups': ['admin'] };
        return;
      }
      try {
        const user = await AuthService.authenticateUser(request.headers.authorization);
        (request as any).user = user;
      } catch (err: any) {
        return reply.code(401).send({ error: err?.message ?? 'unauthorized' });
      }
    });

    this.app.addHook('onRequest', async (req) => {
      console.log(JSON.stringify({
        level: 30, time: Date.now(), method: req.method, url: req.url,
        ua: (req.headers['user-agent'] || '').toString().slice(0, 120), ip: req.ip
      }));
    });
  }

  private setupRoutes() {
    // Signed weight upload
    this.app.post('/api/v1/fl/weights', async (request, reply) => {
      try {
        const user = (request as any).user;
        if (!user) return reply.code(401).send({ error: 'unauthorized' });

        const rawAny = (request as any).rawBody as Buffer | string | undefined;
        const parsedJson = request.body ?? {};
        const canonical = JSON.stringify(parsedJson);
        let rawStr: string | undefined;
        if (Buffer.isBuffer(rawAny)) rawStr = rawAny.toString('utf8');
        else if (typeof rawAny === 'string') rawStr = rawAny;

        const toVerify: string[] = [];
        if (rawStr) toVerify.push(rawStr);
        toVerify.push(canonical);

        if ((rawStr?.length ?? canonical.length) > 2 * 1024 * 1024) {
          return reply.code(413).send({ error: 'payload too large' });
        }

        const signature = request.headers['x-signature'] as string | undefined;
        if (!signature) return reply.code(403).send({ error: 'missing signature' });

        const good = toVerify.some((s) => SecurityUtils.validateHMAC(s, signature, config.DEVICE_HMAC_SECRET));
        if (!good) return reply.code(403).send({ error: 'invalid signature' });

        const body = z.object({
          siteId: z.string().min(1).max(50).regex(/^[a-zA-Z0-9_-]+$/),
          modelName: z.string().min(1).max(100),
          weights: z.record(z.string(), z.array(z.number().finite())),
          dataSampleCount: z.number().positive(),
          dataQuality: z.number().min(0).max(1).default(1.0),
          timestamp: z.coerce.number().positive(),
          nonce: z.string().uuid(),
        }).parse(parsedJson);

        if (!SecurityUtils.isRecentTimestamp(Number(body.timestamp))) {
          return reply.code(400).send({ error: 'stale or future timestamp' });
        }

        const nonceKey = `fl:{${body.modelName}}:nonce:${body.siteId}:${body.nonce}`;
        const ok = await this.db.client.set(nonceKey, '1', 'PX', 5 * 60_000, 'NX');
        if (!ok) return reply.code(409).send({ error: 'replay detected' });

        const ts = Date.now();
        const updateKey = `fl:{${body.modelName}}:pending:${body.modelName}:${body.siteId}:${ts}`;
        const doc = { ...body, receivedAt: new Date().toISOString(), uploadedBy: (user as any).sub ?? 'dev' };
        await this.db.client.setex(updateKey, 3600, JSON.stringify(doc));

        return reply.send({
          status: 'uploaded',
          key: updateKey,
          siteId: body.siteId,
          modelName: body.modelName,
          sizeBytes: Buffer.byteLength(rawStr ?? canonical, 'utf8'),
          receivedAt: doc.receivedAt,
        });
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? 'bad request' });
      }
    });

    // Manual aggregation (dev)
    this.app.post('/api/v1/fl/aggregate-now', async (request, reply) => {
      const body = z.object({ modelName: z.string().min(1).max(100) }).parse(request.body);
      const res = await this.aggregateNow(body.modelName);
      return reply.send(res);
    });

    // MODEL RETRIEVAL + HISTORY (new)
    this.app.get('/api/v1/fl/model/:modelName', async (request, reply) => {
      const params = z.object({ modelName: z.string().min(1).max(100) }).parse(request.params);
      const query = z.object({ version: z.string().optional() }).parse(request.query);
      const key = query.version
        ? `fl:models:${params.modelName}:${query.version}`
        : `fl:models:${params.modelName}:latest`;

      const data = await this.db.client.get(key);
      if (!data) return reply.code(404).send({ error: 'model not found' });

      const history = await this.db.client.lrange(`fl:models:${params.modelName}:history`, 0, -1);
      const payload = JSON.parse(data);
      return reply.send({ ...payload, availableVersions: history });
    });

    // Public metrics
    this.app.get('/api/v1/metrics', async (_req, reply) => {
      try {
        const m = await this.metrics.getSystemMetrics();
        reply.send(m);
      } catch (e: any) {
        reply.code(500).send({ error: e?.message ?? 'metrics failed' });
      }
    });
  }

  // === helpers inside class ===
  private async aggregateNow(modelName: string) {
    const moved = await this.db.markPendingToProcessing(modelName);
    const updates = await this.db.getFLUpdates(modelName, 'processing');

    if (updates.length < Number(config.FL_MIN_PARTICIPANTS)) {
      const pipe = this.db.client.pipeline();
      for (const { key } of updates) pipe.rename(key, key.replace(':processing:', ':pending:'));
      await pipe.exec();
      return { aggregated: false, reason: 'not_enough_participants', participants: updates.length, moved };
    }

    const result = await this.flAggregator.performAggregation(
      modelName,
      updates.map((u) => u.data)
    );

    const version = `v${Date.now()}`;
    const payload = {
      modelName,
      weights: result.weights,
      metadata: result.metadata,
      createdAt: new Date().toISOString(),
      participantCount: result.metadata.participantCount,
      aggregationTimeMs: result.metadata.aggregationTimeMs ?? 0,
      version,
    };

    const pipe = this.db.client.pipeline();
    pipe.setex(`fl:models:${modelName}:${version}`, 7 * 24 * 3600, JSON.stringify(payload));
    pipe.setex(`fl:models:${modelName}:latest`, 24 * 3600, JSON.stringify(payload));
    pipe.lpush(`fl:models:${modelName}:history`, version);
    pipe.ltrim(`fl:models:${modelName}:history`, 0, 9);
    for (const { key } of updates) pipe.del(key);
    await pipe.exec();

    return { aggregated: true, version, participants: updates.length };
  }

  private setupHealth() {
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

    this.app.get('/ready', async (_req, reply) => {
      reply.send({ status: 'ready' });
    });
  }

  async start() {
    await this.app.listen({ host: '0.0.0.0', port: Number(config.PORT) || 3000 });
    console.log(JSON.stringify({ level: 30, time: Date.now(), port: Number(config.PORT) || 3000, env: config.NODE_ENV, msg: 'Rita server started' }));
  }
}

const server = new RitaServer();
if (process.env.NODE_ENV !== 'test') {
  server.start().catch((err) => {
    console.error(JSON.stringify({ level: 50, time: Date.now(), msg: 'startup failed', err: err?.message }));
    process.exit(1);
  });
}
export default server;
