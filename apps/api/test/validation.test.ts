import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import {
  InMemoryUserRepository,
  InMemoryIncidentRepository,
} from '../src/repositories/in-memory-repository.js';
import { RateLimiter } from '../src/middleware/rate-limiter.js';

describe('Zod Input Validation Integration Tests', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const userRepo = new InMemoryUserRepository();
    const incidentRepo = new InMemoryIncidentRepository();
    const rateLimiter = new RateLimiter({ maxRequests: 50, windowMs: 60000 });

    app = await buildApp({
      userRepository: userRepo,
      incidentRepository: incidentRepo,
      rateLimiter,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /incidents validation', () => {
    it('should reject when required fields are missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/incidents',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Bad Request');
      expect(body.issues).toBeDefined();
      expect(Array.isArray(body.issues)).toBe(true);
    });

    it('should reject invalid severity below 1 or above 5', async () => {
      const resBelow = await app.inject({
        method: 'POST',
        url: '/incidents',
        payload: {
          title: 'Severity test',
          type: 'accident',
          severity: 0,
          description: 'Testing severity constraint below 1',
          latitude: 37.77,
          longitude: -122.41,
        },
      });
      expect(resBelow.statusCode).toBe(400);

      const resAbove = await app.inject({
        method: 'POST',
        url: '/incidents',
        payload: {
          title: 'Severity test',
          type: 'accident',
          severity: 6,
          description: 'Testing severity constraint above 5',
          latitude: 37.77,
          longitude: -122.41,
        },
      });
      expect(resAbove.statusCode).toBe(400);
    });

    it('should reject non-integer severity', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/incidents',
        payload: {
          title: 'Severity test',
          type: 'accident',
          severity: 3.5,
          description: 'Testing float severity',
          latitude: 37.77,
          longitude: -122.41,
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject invalid coordinates (out of range)', async () => {
      // Latitude > 90
      const resLat = await app.inject({
        method: 'POST',
        url: '/incidents',
        payload: {
          title: 'Invalid lat',
          type: 'hazard',
          severity: 2,
          description: 'Testing invalid latitude',
          latitude: 95.5,
          longitude: -122.41,
        },
      });
      expect(resLat.statusCode).toBe(400);

      // Longitude < -180
      const resLng = await app.inject({
        method: 'POST',
        url: '/incidents',
        payload: {
          title: 'Invalid lng',
          type: 'hazard',
          severity: 2,
          description: 'Testing invalid longitude',
          latitude: 37.77,
          longitude: -195.0,
        },
      });
      expect(resLng.statusCode).toBe(400);
    });

    it('should reject invalid incident type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/incidents',
        payload: {
          title: 'Invalid type',
          type: 'alien_invasion',
          severity: 5,
          description: 'Unknown type not in enum',
          latitude: 37.77,
          longitude: -122.41,
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject too short title or description', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/incidents',
        payload: {
          title: 'No',
          type: 'accident',
          severity: 1,
          description: 'Hi',
          latitude: 37.77,
          longitude: -122.41,
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /incidents?bbox=... query validation', () => {
    it('should reject malformed bbox (not enough coordinates)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/incidents?bbox=-122.5,37.7,-122.3',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Bad Request');
    });

    it('should reject malformed bbox where min coordinates exceed max coordinates', async () => {
      // minLng (10) > maxLng (5)
      const res = await app.inject({
        method: 'GET',
        url: '/incidents?bbox=10,20,5,30',
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject non-numeric bbox coordinates', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/incidents?bbox=abc,def,ghi,jkl',
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject invalid since timestamp', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/incidents?since=not-a-valid-date',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /auth/register validation', () => {
    it('should reject invalid email format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'not-an-email',
          password: 'password123',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject password shorter than 6 characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'valid@example.com',
          password: '123',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject invalid role', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'valid@example.com',
          password: 'password123',
          role: 'superhero',
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
