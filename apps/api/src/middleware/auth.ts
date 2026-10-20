import { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { AuthTokenPayload, SafeUser, User, UserRole } from '@safetymap/shared';
import { env } from '../config/env.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthTokenPayload;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(payload: AuthTokenPayload, secret: string = env.JWT_SECRET): string {
  return jwt.sign(payload, secret, { expiresIn: '24h' });
}

export function verifyToken(token: string, secret: string = env.JWT_SECRET): AuthTokenPayload {
  return jwt.verify(token, secret) as AuthTokenPayload;
}

export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    agencyId: user.agencyId,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header with Bearer token',
    });
    return;
  }

  const token = authHeader.substring(7).trim();
  try {
    const payload = verifyToken(token, request.server.jwtSecret || env.JWT_SECRET);
    request.user = payload;
  } catch (err: unknown) {
    const isExpired = err instanceof Error && err.name === 'TokenExpiredError';
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: isExpired ? 'Token has expired' : 'Invalid token',
    });
  }
}

export async function optionalAuthenticate(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return;
  }

  const token = authHeader.substring(7).trim();
  try {
    const payload = verifyToken(token, request.server.jwtSecret || env.JWT_SECRET);
    request.user = payload;
  } catch {
    // Ignore invalid optional tokens
  }
}

export function requireRole(allowedRoles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    if (!allowedRoles.includes(request.user.role)) {
      reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: `Access denied: route restricted to roles [${allowedRoles.join(', ')}]. Current role: '${request.user.role}'`,
      });
      return;
    }
  };
}
