import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { LoginSchema, RegisterSchema } from '@safetymap/shared';
import {
  authenticate,
  comparePassword,
  generateToken,
  hashPassword,
  toSafeUser,
} from '../middleware/auth.js';
import { IUserRepository } from '../repositories/interfaces.js';

export function createAuthRoutes(userRepository: IUserRepository) {
  return async function (fastify: FastifyInstance, _opts: FastifyPluginOptions) {
    // POST /auth/register
    fastify.post('/register', async (request, reply) => {
      const parsed = RegisterSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation failed',
          issues: parsed.error.issues,
        });
      }

      const { email, password, name, role } = parsed.data;

      const existing = await userRepository.findByEmail(email);
      if (existing) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `User with email '${email}' already exists`,
        });
      }

      const passwordHash = await hashPassword(password);
      const user = await userRepository.create({
        email,
        passwordHash,
        name,
        role,
      });

      const token = generateToken(
        { userId: user.id, email: user.email, role: user.role },
        fastify.jwtSecret,
      );

      return reply.status(201).send({
        statusCode: 201,
        message: 'User registered successfully',
        token,
        user: toSafeUser(user),
      });
    });

    // POST /auth/login
    fastify.post('/login', async (request, reply) => {
      const parsed = LoginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation failed',
          issues: parsed.error.issues,
        });
      }

      const { email, password } = parsed.data;
      const user = await userRepository.findByEmail(email);
      if (!user) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid email or password',
        });
      }

      const isMatch = await comparePassword(password, user.passwordHash);
      if (!isMatch) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid email or password',
        });
      }

      const token = generateToken(
        { userId: user.id, email: user.email, role: user.role },
        fastify.jwtSecret,
      );

      return reply.status(200).send({
        statusCode: 200,
        message: 'Login successful',
        token,
        user: toSafeUser(user),
      });
    });

    // GET /auth/me
    fastify.get('/me', { preHandler: [authenticate] }, async (request, reply) => {
      const user = await userRepository.findById(request.user!.userId);
      if (!user) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'User not found',
        });
      }

      return reply.send({
        statusCode: 200,
        user: toSafeUser(user),
      });
    });
  };
}
