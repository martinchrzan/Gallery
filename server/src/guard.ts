/**
 * Request guards.
 *
 * `authGuard` runs as a root `onRequest` hook, so it covers every `/api/` route
 * in the app — including ones added later — rather than relying on each router
 * to remember to protect itself. Anything not in {@link PUBLIC_API} needs a
 * session; `requireAdmin` narrows individual routes further.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { userFromRequest } from './auth.js';
import type { User } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, populated by {@link authGuard}. */
    authUser: User | null;
  }
}

/**
 * The only endpoints reachable without a session. Login has to be; logout stays
 * open so clearing a stale cookie always works; health exists for uptime checks
 * and reveals nothing but that the server is running. Everything else — the
 * feed, thumbnails, originals, file browsing — is closed by default.
 */
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/health']);

export async function authGuard(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  // Match on the route Fastify actually resolved, not on the raw URL. Routing
  // has already run by the time an onRequest hook fires, so this is the same
  // string the handler is registered under — no string-munging of attacker
  // input, and no chance of the guard and the router disagreeing about which
  // endpoint a request is for.
  const route = req.routeOptions.url;

  // No route matched; the not-found handler answers, and it reveals nothing.
  if (route === undefined) return;

  // Static assets and the SPA shell stay public: the login screen is served
  // from the same bundle, and it holds no secrets.
  if (!route.startsWith('/api/')) return;

  if (PUBLIC_API.has(route)) return;

  const user = userFromRequest(req);
  if (!user) {
    reply.code(401).send({ error: 'Authentication required' });
    return reply;
  }

  req.authUser = user;
  return;
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  if (req.authUser?.role !== 'admin') {
    reply.code(403).send({ error: 'Administrator access required' });
    return reply;
  }
  return;
}

/** The signed-in user for a guarded route. */
export function currentUser(req: FastifyRequest): User {
  if (!req.authUser) throw new Error('Route reached without authentication');
  return req.authUser;
}
