import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  authenticateCode,
  clearSession,
  createUser,
  countAdmins,
  deleteUser,
  getUser,
  listUsers,
  rotateCode,
  startSession,
  updateUser,
} from '../auth.js';
import { currentUser, requireAdmin } from '../guard.js';
import type { AuthState, User, UserWithCode } from '../types.js';

const LoginBody = z.object({ code: z.string().min(1).max(200) }).strict();

const NewUser = z
  .object({
    label: z.string().min(1).max(60),
    role: z.enum(['admin', 'viewer']).default('viewer'),
    folders: z.array(z.string()).max(500).default([]),
  })
  .strict();

const UserPatch = z
  .object({
    label: z.string().min(1).max(60).optional(),
    folders: z.array(z.string()).max(500).optional(),
  })
  .strict();

/** Ten attempts per quarter hour: enough for a mistyped code, useless for guessing. */
const LOGIN_RATE_LIMIT = { max: 10, timeWindow: '15 minutes' };

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter your access code' });

    const user = await authenticateCode(parsed.data.code);
    if (!user) {
      req.log.warn({ ip: req.ip }, 'failed login attempt');
      // Deliberately vague: a viewer must not learn whether a code exists but
      // was for another role, and an attacker learns nothing about user count.
      return reply.code(401).send({ error: 'That access code is not valid' });
    }

    startSession(req, reply, user);
    const state: AuthState = { user };
    return reply.header('Cache-Control', 'no-store').send(state);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    clearSession(req, reply);
    return reply.header('Cache-Control', 'no-store').send({ ok: true });
  });

  /** 401 here is how the client decides to show the login screen. */
  app.get('/api/auth/me', async (req, reply) => {
    const state: AuthState = { user: currentUser(req) };
    return reply.header('Cache-Control', 'no-store').send(state);
  });

  /* ----------------------------------------------------------- users -- */

  app.get('/api/users', { preHandler: requireAdmin }, async (_req, reply) => {
    const users: User[] = listUsers();
    return reply.header('Cache-Control', 'no-store').send(users);
  });

  app.post('/api/users', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = NewUser.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid user', issues: parsed.error.issues });
    }

    const created: UserWithCode = await createUser(parsed.data);
    // The only time the code is ever readable. It is shown once and then only
    // its hash remains, so the UI has to make the admin copy it now.
    return reply.code(201).header('Cache-Control', 'no-store').send(created);
  });

  app.patch<{ Params: { id: string } }>(
    '/api/users/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid id' });

      const parsed = UserPatch.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid patch', issues: parsed.error.issues });
      }

      const user = updateUser(id, parsed.data);
      if (!user) return reply.code(404).send({ error: 'No such user' });
      return reply.header('Cache-Control', 'no-store').send(user);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/users/:id/code',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid id' });

      const code = await rotateCode(id);
      if (!code) return reply.code(404).send({ error: 'No such user' });

      const user = getUser(id);
      if (!user) return reply.code(404).send({ error: 'No such user' });

      const result: UserWithCode = { user, code };
      return reply.header('Cache-Control', 'no-store').send(result);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/users/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid id' });

      const target = getUser(id);
      if (!target) return reply.code(404).send({ error: 'No such user' });

      // Two ways to lock yourself out permanently, both blocked here.
      if (target.id === currentUser(req).id) {
        return reply.code(400).send({ error: 'You cannot delete your own account' });
      }
      if (target.role === 'admin' && countAdmins() <= 1) {
        return reply.code(400).send({ error: 'The last administrator cannot be deleted' });
      }

      deleteUser(id);
      return reply.send({ deleted: true });
    },
  );
}
