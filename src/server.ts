// src/server.ts
import 'dotenv/config';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV ?? 'development';

/** Public endpoints (no auth) */
const isPublic = (rawUrl: string): boolean => {
  const url = rawUrl.split('?')[0];
  return (
    url === '/health' ||
    url === '/openapi.json' ||
    url === '/docs' ||
    url === '/docs/' ||
    url.startsWith('/docs/json') ||
    url.startsWith('/docs/static') ||
    url.startsWith('/docs/')
  );
};

/** Super simple auth guard (replace with real JWT/HMAC later) */
async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  const url = (req.raw?.url as string) || (req.url as string) || '';
  if (isPublic(url)) return;

  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing or invalid authorization header' });
    return reply;
  }

  // TODO: validate token here; 401 if invalid.
}

/** Build app */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // No pino-pretty transport — avoids the crash you saw
    logger: { level: 'info' },
  });

  // Hardening & QoS
  await app.register(cors, { origin: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: 1000,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
  });

  // OpenAPI spec
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'RITA Backend',
        description: 'Federated learning backend API',
        version: '1.0.0',
      },
      servers: [{ url: `http://localhost:${PORT}` }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
    },
  });

  // Direct spec endpoint (public)
  app.get('/openapi.json', async (_req, reply) => reply.send(app.swagger()));

  // Swagger UI at /docs (public)
  await app.register(swaggerUI, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
    transformSpecification: (_s, _req, _reply) => app.swagger(),
    transformSpecificationClone: true,
  });

  // Global auth hook (after swagger is registered, but runs for all routes)
  app.addHook('onRequest', authGuard);

  // Health (public)
  app.get('/health', async (_req, reply) => reply.send({ status: 'ok' }));

  // Example protected API (delete or replace)
  app.get('/api/v1/hello', async (_req, reply) => reply.send({ ok: true }));

  return app;
}

/** Start server (skip in tests) */
async function start() {
  const app = await buildApp();
  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info({ port: PORT, env: NODE_ENV }, 'Rita server started');
  } catch (err) {
    app.log.error(err, 'Failed to start server');
    process.exit(1);
  }
}

if (NODE_ENV !== 'test') {
  void start();
}
