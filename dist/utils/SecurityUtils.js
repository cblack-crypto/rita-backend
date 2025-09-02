import crypto from 'crypto';
export class SecurityUtils {
    static validateHMAC(raw, signature, secret) {
        try {
            const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
            const a = Buffer.from(signature, 'hex');
            const b = Buffer.from(expected, 'hex');
            return a.length === b.length && crypto.timingSafeEqual(a, b);
        }
        catch {
            return false;
        }
    }
    static isRecentTimestamp(ts, windowMs = 300000) {
        const now = Date.now();
        return Math.abs(now - ts) <= windowMs;
    }
}
