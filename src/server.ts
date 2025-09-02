// src/server.ts
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyRawBody from 'fastify-raw-body';
import crypto from 'crypto';
import 'dotenv/config';

const app = Fastify({ logger: true });

// expose raw body for HMAC verification
await app.register(fastifyRawBody, {
  field: 'rawBody',
  global: true,
  encoding: 'utf8',
  runFirst: true,
});

await app.register(cors, { origin: true });
await app.register(helmet);
await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

await app.register(swagger, {
  openapi: {
    info: { title: 'RITA Backend', version: '1.0.0' },
    servers: [{ url: 'http://localhost:3000' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
  },
});

// NOTE: swagger-ui serves /docs and /docs/json for us.
// Do NOT add your own /docs/json route or you’ll get FST_ERR_DUPLICATED_ROUTE.
await app.register(swaggerUi, {
  routePrefix: '/docs',
  staticCSP: true,
  uiConfig: { docExpansion: 'list', deepLinking: true },
});

// ---------- helpers ----------
function ok(res: FastifyReply, payload: Record<string, unknown> = {}) {
  return res.send(payload);
}

// dev auth: allow Authorization: Bearer dev-simulator OR x-dev-user: dev-simulator
function authGuard(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const bearer = (req.headers['authorization'] || '') as string;
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : undefined;
  const devUser = req.headers['x-dev-user'] as string | undefined;
  if (token === 'dev-simulator' || devUser === 'dev-simulator') return done();
  reply.code(401).send({ error: 'Missing or invalid authorization header' });
}

function isValidSignature(raw: string, headerSig?: string): boolean {
  const secret = process.env.DEVICE_HMAC_SECRET || '';
  if (!secret || !headerSig) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return headerSig.toLowerCase() === expected.toLowerCase();
}

// track replays
const seenBodies = new Set<string>();

// ---------- routes ----------
app.get('/health', async (_req, res) => ok(res, { status: 'ok' }));

app.get('/api/v1/hello', async (_req, res) => ok(res, { hello: 'world' }));

app.post('/api/v1/fl/weights', { preHandler: authGuard }, async (req, reply) => {
  const raw =
    (req as any).rawBody?.toString?.() ??
    JSON.stringify(req.body ?? {});
  const sig = (req.headers['x-signature'] as string | undefined) ?? '';

  if (!isValidSignature(raw, sig)) {
    return reply.code(401).send({ error: 'bad signature' });
  }

  const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
  if (seenBodies.has(bodyHash)) {
    return reply.code(409).send({ error: 'duplicate' });
  }

  seenBodies.add(bodyHash);
  setTimeout(() => seenBodies.delete(bodyHash), 5 * 60 * 1000);

  return reply.code(200).send({ accepted: true });
});

// ---------- start ----------
const port = Number(process.env.PORT || 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info({ port, env: process.env.NODE_ENV || 'development' }, 'Rita server started'))
  .catch((err) => {
    app.log.error(err, 'startup failed');
    process.exit(1);
  });

export {};
