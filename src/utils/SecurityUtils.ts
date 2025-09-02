import crypto from 'crypto';

export class SecurityUtils {
  static validateHMAC(raw: string, signature: string, secret: string): boolean {
    try {
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      const a = Buffer.from(signature, 'hex');
      const b = Buffer.from(expected, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
  static isRecentTimestamp(ts: number, windowMs = 300000): boolean {
    const now = Date.now();
    return Math.abs(now - ts) <= windowMs;
  }
}
