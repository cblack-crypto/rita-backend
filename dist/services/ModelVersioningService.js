export class ModelVersioningService {
    db;
    constructor(db) {
        this.db = db;
    }
    async saveModelVersion(modelName, modelData) {
        const version = `v${Date.now()}`;
        const pipe = this.db.client.pipeline();
        pipe.sadd('fl:models:set', modelName);
        pipe.set(`fl:models:${modelName}:latest`, JSON.stringify({ ...modelData, version }));
        pipe.lpush(`fl:models:${modelName}:history`, version);
        pipe.ltrim(`fl:models:${modelName}:history`, 0, 9);
        await pipe.exec();
        return version;
    }
    async getModelHistory(modelName) {
        return this.db.client.lrange(`fl:models:${modelName}:history`, 0, -1);
    }
    async getModelVersion(modelName, version) {
        const key = version ? `fl:models:${modelName}:${version}` : `fl:models:${modelName}:latest`;
        const data = await this.db.client.get(key);
        return data ? JSON.parse(data) : null;
    }
}
