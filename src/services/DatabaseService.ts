// src/services/DatabaseService.ts
import Redis from 'ioredis';
import pino from 'pino';
import crypto from 'crypto';
import { config } from '../config.js';

const logger = pino({ level: config.NODE_ENV === 'production' ? 'info' : 'debug' });

export class DatabaseService {
  private redisClient: Redis;
  constructor() {
    this.redisClient = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
    });
    this.redisClient.on('error', (err) => {
      logger.error({ err }, 'Redis error');
    });
  }

  get client() { return this.redisClient; }

  async scanKeys(pattern: string, count = 200): Promise<string[]> {
    const keys: string[] = [];
    const stream = this.redisClient.scanStream({ match: pattern, count });
    return new Promise((resolve, reject) => {
      stream.on('data', (ks: string[]) => keys.push(...ks));
      stream.on('end', () => resolve(keys));
      stream.on('error', reject);
    });
  }

  // --- NEW: counts & fetches for FL updates ---
  async countPendingForModel(modelName: string): Promise<number> {
    const pattern = `fl:{${modelName}}:pending:${modelName}:*`;
    const keys = await this.scanKeys(pattern);
    return keys.length;
  }

  async getFLUpdates(modelName: string, status: 'pending' | 'processing') {
    const pattern = `fl:{${modelName}}:${status}:${modelName}:*`;
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) return [];
    const pipe = this.redisClient.pipeline();
    keys.forEach(k => pipe.get(k));
    const res = await pipe.exec();
    return res?.map((r, i) => ({
      key: keys[i],
      data: r?.[1] ? JSON.parse(r[1] as string) : null
    })).filter(x => x.data) ?? [];
  }

  async markPendingToProcessing(modelName: string): Promise<string[]> {
    const pending = await this.getFLUpdates(modelName, 'pending');
    if (pending.length === 0) return [];
    const pipe = this.redisClient.pipeline();
    for (const { key } of pending) {
      const dest = key.replace(':pending:', ':processing:');
      pipe.rename(key, dest); // safe because keys share the same hash-tag {modelName}
    }
    await pipe.exec();
    return pending.map(p => p.key.replace(':pending:', ':processing:'));
  }

  // --- NEW: simple lock helper using EVAL to safely release ---
  async withLock(lockKey: string, ttlMs: number, fn: () => Promise<void>) {
    const token = crypto.randomUUID();
    const ok = await this.redisClient.set(lockKey, token, 'PX', ttlMs, 'NX');
    if (!ok) return false;
    try {
      await fn();
      return true;
    } finally {
      const lua = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await this.redisClient.eval(lua, 1, lockKey, token);
    }
  }

  async close() { await this.redisClient.quit(); }
}
