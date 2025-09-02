import fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import pino from 'pino';
import { config } from './config.js';
import { DatabaseService } from './services/DatabaseService.js';
import { AuthService } from './services/AuthService.js';
import { MetricsService } from './services/MetricsService.js';
const logger = pino({ level: config.NODE_ENV === 'production' ? 'info' : 'debug' });
export class RitaServer {
    app;
    db;
    metrics;
    constructor() {
        this.app = fastify({ logger: false, trustProxy: true, bodyLimit: 10 * 1024 * 1024, requestTimeout: 30000 });
        this.db = new DatabaseService();
        this.metrics = new MetricsService(this.db);
        this.setupMiddleware();
        this.setupRoutes();
        this.setupHealth();
    }
    setupMiddleware() {
        this.app.register(helmet, { contentSecurityPolicy: false });
        this.app.register(cors, { origin: true, credentials: true });
        this.app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
        this.app.addHook('onRequest', async (req) => {
            logger.info({ method: req.method, url: req.url, ip: req.ip }, 'req');
        });
        // very light dev auth for now
        this.app.addHook('preHandler', async (req, reply) => {
            const publicPaths = ['/health', '/ready', '/api/v1/metrics'];
            if (publicPaths.some(p => req.url.startsWith(p)))
                return;
            try {
                const user = await AuthService.authenticateUser(req.headers.authorization, req.headers['x-dev-user']);
                req.user = user;
            }
            catch (e) {
                reply.code(401).send({ error: e.message });
            }
        });
    }
    setupRoutes() {
        this.app.get('/api/v1/metrics', async () => {
            return await this.metrics.getSystemMetrics();
        });
    }
    setupHealth() {
        this.app.get('/health', async () => {
            await this.db.client.ping();
            const mem = process.memoryUsage();
            return {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                memory: {
                    used: Math.round(mem.heapUsed / 1024 / 1024),
                    total: Math.round(mem.heapTotal / 1024 / 1024),
                }
            };
        });
        this.app.get('/ready', async () => ({ status: 'ready' }));
    }
    async start() {
        try {
            await this.app.listen({ port: config.PORT, host: '0.0.0.0' });
            logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Rita server started');
        }
        catch (e) {
            logger.error({ err: e }, 'start failed');
            process.exit(1);
        }
    }
}
if (process.env.NODE_ENV !== 'test') {
    new RitaServer().start();
}
export default RitaServer;
