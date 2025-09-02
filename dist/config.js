import * as dotenv from 'dotenv';
import { z } from 'zod';
dotenv.config();
const ConfigSchema = z.object({
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
    AWS_REGION: z.string().default('us-east-1'),
    USER_POOL_ID: z.string().default('dummy'),
    CLIENT_ID: z.string().default('dummy'),
    TIMESTREAM_DB: z.string().default('dummy'),
    TIMESTREAM_TABLE: z.string().default('dummy'),
    S3_BUCKET: z.string().default('dummy'),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    DEVICE_HMAC_SECRET: z.string().min(32),
    JWT_SECRET: z.string().min(32),
    FL_MIN_PARTICIPANTS: z.coerce.number().default(3),
    FL_AGGREGATION_THRESHOLD: z.coerce.number().default(5),
});
export const config = ConfigSchema.parse(process.env);
