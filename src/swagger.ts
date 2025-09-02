import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

export default fp(async function swaggerPlugin(app: FastifyInstance) {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'RITA AI Backend',
        description: 'Federated Learning API',
        version: '1.0.0',
      },
      servers: [{ url: 'http://localhost:3000' }],
      components: {},
      tags: [
        { name: 'health', description: 'Service health' },
        { name: 'fl', description: 'Federated learning' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'none', deepLinking: true },
    staticCSP: true,
    transformSpecificationClone: true,
  });

  // expose raw spec as json
  app.get('/openapi.json', async (_req, reply) => {
    // @ts-ignore - fastify-swagger decorates instance
    return reply.send(app.swagger());
  });
});
