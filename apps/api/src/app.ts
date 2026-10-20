import fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { RateLimiter, RateLimiterOptions } from './middleware/rate-limiter.js';
import {
  InMemoryIncidentRepository,
  InMemoryUserRepository,
} from './repositories/in-memory-repository.js';
import {
  PostgresIncidentRepository,
  PostgresUserRepository,
} from './repositories/postgres-repository.js';
import { IIncidentRepository, IUserRepository } from './repositories/interfaces.js';
import { createAuthRoutes } from './routes/auth.routes.js';
import { createIncidentRoutes } from './routes/incident.routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    jwtSecret: string;
    userRepository: IUserRepository;
    incidentRepository: IIncidentRepository;
    rateLimiter: RateLimiter;
  }
}

export interface AppOptions extends FastifyServerOptions {
  userRepository?: IUserRepository;
  incidentRepository?: IIncidentRepository;
  rateLimiter?: RateLimiter;
  rateLimiterOptions?: RateLimiterOptions;
  jwtSecret?: string;
  usePostgres?: boolean;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = fastify({
    logger: false,
    ...options,
  });

  const jwtSecret = options.jwtSecret || env.JWT_SECRET;
  app.decorate('jwtSecret', jwtSecret);

  // Initialize repositories
  let userRepository: IUserRepository;
  let incidentRepository: IIncidentRepository;

  if (options.userRepository) {
    userRepository = options.userRepository;
  } else if (options.usePostgres && env.DATABASE_URL) {
    userRepository = new PostgresUserRepository(env.DATABASE_URL);
  } else {
    userRepository = new InMemoryUserRepository();
  }

  if (options.incidentRepository) {
    incidentRepository = options.incidentRepository;
  } else if (options.usePostgres && env.DATABASE_URL) {
    incidentRepository = new PostgresIncidentRepository(env.DATABASE_URL);
  } else {
    incidentRepository = new InMemoryIncidentRepository();
  }

  const rateLimiter =
    options.rateLimiter ||
    new RateLimiter(
      options.rateLimiterOptions || {
        maxRequests: env.RATE_LIMIT_MAX_PER_WINDOW,
        windowMs: env.RATE_LIMIT_WINDOW_MS,
      },
    );

  app.decorate('userRepository', userRepository);
  app.decorate('incidentRepository', incidentRepository);
  app.decorate('rateLimiter', rateLimiter);

  // Register CORS
  await app.register(cors, {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(','),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  });

  // Global Error Handler for Zod and unexpected errors
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        issues: error.issues,
      });
    }

    const statusCode = error.statusCode || 500;
    return reply.status(statusCode).send({
      statusCode,
      error: error.name || 'InternalServerError',
      message: error.message || 'An unexpected error occurred',
    });
  });

  // Health check endpoint
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // Register Routes
  // Auth routes (registered at /auth and /api/v1/auth)
  await app.register(createAuthRoutes(userRepository), { prefix: '/auth' });
  await app.register(createAuthRoutes(userRepository), { prefix: '/api/v1/auth' });

  // Incident routes (registered at /incidents and /api/v1/incidents)
  await app.register(createIncidentRoutes(incidentRepository, rateLimiter), {
    prefix: '/incidents',
  });
  await app.register(createIncidentRoutes(incidentRepository, rateLimiter), {
    prefix: '/api/v1/incidents',
  });

  return app;
}
