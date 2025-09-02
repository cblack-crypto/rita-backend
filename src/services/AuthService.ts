import { config } from '../config.js';

type AuthUser = {
  sub: string;
  groups?: string[];
  /** Cognito injects this */
  ['cognito:groups']?: string[];
};

export class AuthService {
  static async authenticateUser(authHeader?: string, devUser?: string): Promise<AuthUser> {
    if (config.NODE_ENV !== 'production' && devUser) {
      return { sub: devUser, groups: ['admin'] };
    }
    if (!authHeader?.startsWith('Bearer ')) {
      throw new Error('Missing or invalid authorization header');
    }
    // TODO: wire to Cognito verifier
    return { sub: 'user', groups: ['viewer'] };
  }

  static hasPermission(user: Record<string, unknown>, required: string): boolean {
    const cand =
      (user['cognito:groups'] as unknown) ??
      (user['groups'] as unknown);

    const groups: string[] = Array.isArray(cand) ? (cand as string[]) : [];

    // Admins get everything
    if (groups.includes('admin') || groups.includes('super_admin')) return true;

    const perms: Record<string, readonly string[]> = {
      operator: ['fl:participate', 'fl:view', 'model:download'],
      viewer: ['fl:view', 'model:download'],
      maintenance: ['fl:view'],
    };

    return groups.some((g: string) => (perms[g]?.includes(required) ?? false));
  }
}
