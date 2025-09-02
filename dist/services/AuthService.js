import { config } from '../config.js';
export class AuthService {
    static async authenticateUser(authHeader, devUser) {
        if (config.NODE_ENV !== 'production' && devUser) {
            return { sub: devUser, groups: ['admin'] };
        }
        if (!authHeader?.startsWith('Bearer ')) {
            throw new Error('Missing or invalid authorization header');
        }
        // TODO: wire to Cognito verifier
        return { sub: 'user', groups: ['viewer'] };
    }
    static hasPermission(user, required) {
        const cand = user['cognito:groups'] ??
            user['groups'];
        const groups = Array.isArray(cand) ? cand : [];
        // Admins get everything
        if (groups.includes('admin') || groups.includes('super_admin'))
            return true;
        const perms = {
            operator: ['fl:participate', 'fl:view', 'model:download'],
            viewer: ['fl:view', 'model:download'],
            maintenance: ['fl:view'],
        };
        return groups.some((g) => (perms[g]?.includes(required) ?? false));
    }
}
