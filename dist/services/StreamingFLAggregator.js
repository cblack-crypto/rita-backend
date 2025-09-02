import pino from 'pino';
import { config } from '../config.js';
const logger = pino({ level: config.NODE_ENV === 'production' ? 'info' : 'debug' });
export class StreamingFLAggregator {
    calculateClientWeight(sampleCount, dataQuality = 1.0, strategy = 'data_size') {
        switch (strategy) {
            case 'uniform': return 1.0;
            case 'data_quality': return dataQuality;
            default: return sampleCount;
        }
    }
    async aggregateWeightsStreaming(modelName, updates) {
        if (updates.length === 0)
            throw new Error('No updates to aggregate');
        const template = updates[0].weights;
        const result = {};
        for (const layerName of Object.keys(template)) {
            const size = template[layerName].length;
            result[layerName] = new Array(size).fill(0);
            let total = 0;
            for (const u of updates) {
                if (!u.weights[layerName] || u.weights[layerName].length !== size) {
                    logger.warn({ siteId: u.siteId, layerName }, 'Layer size mismatch');
                    continue;
                }
                total += u.weight;
                for (let i = 0; i < size; i++)
                    result[layerName][i] += u.weights[layerName][i] * u.weight;
                delete u.weights[layerName];
            }
            if (total > 0)
                for (let i = 0; i < size; i++)
                    result[layerName][i] /= total;
            logger.debug({ modelName, layerName, size }, 'Layer aggregated');
        }
        return result;
    }
    async performAggregation(modelName, pendingUpdates) {
        const start = Date.now();
        const weighted = pendingUpdates.map(u => ({
            siteId: u.siteId,
            weights: u.weights,
            weight: this.calculateClientWeight(u.dataSampleCount, u.dataQuality || 1.0),
        }));
        const weights = await this.aggregateWeightsStreaming(modelName, weighted);
        return {
            weights,
            metadata: {
                participantCount: pendingUpdates.length,
                aggregationTimeMs: Date.now() - start,
                participants: pendingUpdates.map(u => u.siteId),
            }
        };
    }
}
