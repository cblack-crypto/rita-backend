import { DatabaseService } from './DatabaseService.js';

export class ModelVersioningService {
  constructor(private db: DatabaseService) {}
  async saveModelVersion(modelName: string, modelData: any) {
    const version = `v${Date.now()}`;
    const pipe = this.db.client.pipeline();
    pipe.sadd('fl:models:set', modelName);
    pipe.set(`fl:models:${modelName}:latest`, JSON.stringify({ ...modelData, version }));
    pipe.lpush(`fl:models:${modelName}:history`, version);
    pipe.ltrim(`fl:models:${modelName}:history`, 0, 9);
    await pipe.exec();
    return version;
  }
  async getModelHistory(modelName: string) {
    return this.db.client.lrange(`fl:models:${modelName}:history`, 0, -1);
  }
  async getModelVersion(modelName: string, version?: string) {
    const key = version ? `fl:models:${modelName}:${version}` : `fl:models:${modelName}:latest`;
    const data = await this.db.client.get(key);
    return data ? JSON.parse(data) : null;
  }
}
