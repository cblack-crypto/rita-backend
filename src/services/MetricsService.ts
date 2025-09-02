import { DatabaseService } from './DatabaseService.js';
import { config } from '../config.js';

export class MetricsService {
  constructor(private db: DatabaseService) {}
  async getSystemMetrics() {
    const activeModels = await this.db.client.scard('fl:models:set');
    const mem = process.memoryUsage();
    const uptime = process.uptime();
    return {
      timestamp: new Date().toISOString(),
      system: {
        uptime: Math.floor(uptime),
        memory: {
          used: Math.round(mem.heapUsed/1024/1024),
          total: Math.round(mem.heapTotal/1024/1024),
          utilization: Math.round((mem.heapUsed/mem.heapTotal) * 100),
        },
        nodeVersion: process.version,
        environment: config.NODE_ENV,
      },
      federatedLearning: {
        activeModels: Number(activeModels),
        totalPendingUpdates: 0, // simplified here
        aggregationThreshold: config.FL_AGGREGATION_THRESHOLD,
        minParticipants: config.FL_MIN_PARTICIPANTS,
      }
    };
  }
}
