import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import {
  CreateIncidentSchema,
  IncidentIdParamSchema,
  QueryIncidentsSchema,
  VerifyIncidentSchema,
} from '@safetymap/shared';
import { authenticate, optionalAuthenticate, requireRole } from '../middleware/auth.js';
import { RateLimiter } from '../middleware/rate-limiter.js';
import { IIncidentRepository } from '../repositories/interfaces.js';

export function createIncidentRoutes(
  incidentRepository: IIncidentRepository,
  rateLimiter: RateLimiter,
) {
  return async function (fastify: FastifyInstance, _opts: FastifyPluginOptions) {
    // -------------------------------------------------------------
    // POST /incidents
    // Creates an incident report.
    // Constraints:
    //  - Validates input with Zod
    //  - Rate-limited per user AND per IP
    // -------------------------------------------------------------
    fastify.post(
      '/',
      {
        preHandler: [optionalAuthenticate, rateLimiter.getMiddleware()],
      },
      async (request, reply) => {
        const parsed = CreateIncidentSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({
            statusCode: 400,
            error: 'Bad Request',
            message: 'Validation failed',
            issues: parsed.error.issues,
          });
        }

        const feature = await incidentRepository.create({
          ...parsed.data,
          reportedBy: request.user?.userId,
        });

        return reply.status(201).send(feature);
      },
    );

    // -------------------------------------------------------------
    // GET /incidents?bbox=&type=&since=&limit=
    // Query incidents within a bounding box, filtered by type and date.
    // Constraints:
    //  - Returns standard GeoJSON FeatureCollection for map queries
    //  - Validated with Zod
    // -------------------------------------------------------------
    fastify.get('/', async (request, reply) => {
      const parsed = QueryIncidentsSchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid query parameters',
          issues: parsed.error.issues,
        });
      }

      const { bbox, type, since, limit } = parsed.data;
      const collection = await incidentRepository.findByQuery({
        bbox,
        type,
        since,
        limit,
      });

      return reply.status(200).send(collection);
    });

    // -------------------------------------------------------------
    // GET /incidents/:id
    // Fetch a single incident by ID
    // -------------------------------------------------------------
    fastify.get('/:id', async (request, reply) => {
      const parsed = IncidentIdParamSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid incident ID parameter',
          issues: parsed.error.issues,
        });
      }

      const { id } = parsed.data;
      const feature = await incidentRepository.findById(id);
      if (!feature) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Incident with ID '${id}' not found`,
        });
      }

      return reply.status(200).send(feature);
    });

    // -------------------------------------------------------------
    // POST /incidents/:id/verify
    // Agency-only route!
    // Constraints:
    //  - Requires authentication with role: agency
    //  - Validated with Zod
    // -------------------------------------------------------------
    fastify.post(
      '/:id/verify',
      {
        preHandler: [authenticate, requireRole(['agency'])],
      },
      async (request, reply) => {
        const paramParsed = IncidentIdParamSchema.safeParse(request.params);
        if (!paramParsed.success) {
          return reply.status(400).send({
            statusCode: 400,
            error: 'Bad Request',
            message: 'Invalid incident ID parameter',
            issues: paramParsed.error.issues,
          });
        }

        const bodyParsed = VerifyIncidentSchema.safeParse(request.body || {});
        if (!bodyParsed.success) {
          return reply.status(400).send({
            statusCode: 400,
            error: 'Bad Request',
            message: 'Invalid verification payload',
            issues: bodyParsed.error.issues,
          });
        }

        const { id } = paramParsed.data;
        const { notes, status } = bodyParsed.data;

        const updated = await incidentRepository.verify(id, request.user!.userId, notes, status);

        if (!updated) {
          return reply.status(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: `Incident with ID '${id}' not found`,
          });
        }

        return reply.status(200).send(updated);
      },
    );
  };
}
