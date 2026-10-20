import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import {
  InMemoryUserRepository,
  InMemoryIncidentRepository,
} from '../src/repositories/in-memory-repository.js';
import { RateLimiter } from '../src/middleware/rate-limiter.js';

describe('Auth & Role-Based Access Control Integration Tests', () => {
  let app: FastifyInstance;
  let userRepo: InMemoryUserRepository;
  let incidentRepo: InMemoryIncidentRepository;

  beforeEach(async () => {
    userRepo = new InMemoryUserRepository();
    incidentRepo = new InMemoryIncidentRepository();
    const rateLimiter = new RateLimiter({ maxRequests: 50, windowMs: 60000 });

    app = await buildApp({
      userRepository: userRepo,
      incidentRepository: incidentRepo,
      rateLimiter,
      jwtSecret: 'test-jwt-secret-xyz',
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /auth/register', () => {
    it('should register a new user with default traveler role', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'traveler1@example.com',
          password: 'password123',
          name: 'Jane Traveler',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.token).toBeDefined();
      expect(body.user.email).toBe('traveler1@example.com');
      expect(body.user.role).toBe('traveler');
      expect(body.user.name).toBe('Jane Traveler');
      expect(body.user.passwordHash).toBeUndefined(); // Password hash must never leak
    });

    it('should register agency user when role is specified', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'officer1@sfsafety.gov',
          password: 'secureAgencyPassword456',
          name: 'Officer Davis',
          role: 'agency',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.user.role).toBe('agency');
      expect(body.token).toBeDefined();
    });

    it('should reject registration if email is already taken', async () => {
      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'duplicate@example.com',
          password: 'password123',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'duplicate@example.com',
          password: 'differentPassword',
        },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Conflict');
      expect(body.message).toContain('already exists');
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: 'user@example.com',
          password: 'validPassword123',
          role: 'local',
        },
      });
    });

    it('should log in with correct credentials and return JWT', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'user@example.com',
          password: 'validPassword123',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.token).toBeDefined();
      expect(body.user.email).toBe('user@example.com');
      expect(body.user.role).toBe('local');
    });

    it('should reject login with wrong password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'user@example.com',
          password: 'wrongPassword',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toContain('Invalid email or password');
    });

    it('should reject login for non-existent user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'unknown@example.com',
          password: 'password123',
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('Role-Based Access Control: Agency-Only Route (POST /incidents/:id/verify)', () => {
    let incidentId: string;
    let travelerToken: string;
    let localToken: string;
    let agencyToken: string;

    beforeEach(async () => {
      // 1. Create a traveler
      const travelerRes = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'traveler@test.com', password: 'password123', role: 'traveler' },
      });
      travelerToken = JSON.parse(travelerRes.body).token;

      // 2. Create a local
      const localRes = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'local@test.com', password: 'password123', role: 'local' },
      });
      localToken = JSON.parse(localRes.body).token;

      // 3. Create an agency user
      const agencyRes = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'agency@test.gov', password: 'password123', role: 'agency' },
      });
      agencyToken = JSON.parse(agencyRes.body).token;

      // 4. Create an incident
      const incRes = await app.inject({
        method: 'POST',
        url: '/incidents',
        headers: { authorization: `Bearer ${travelerToken}` },
        payload: {
          title: 'Traffic accident on 5th Ave',
          type: 'accident',
          severity: 3,
          description: 'Two cars involved, minor delays',
          latitude: 37.7749,
          longitude: -122.4194,
        },
      });
      incidentId = JSON.parse(incRes.body).id;
    });

    it('should reject unauthenticated request to /verify with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/incidents/${incidentId}/verify`,
        payload: { notes: 'Attempting verify without auth' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Unauthorized');
    });

    it('should reject traveler role from /verify with 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/incidents/${incidentId}/verify`,
        headers: { authorization: `Bearer ${travelerToken}` },
        payload: { notes: 'Traveler trying to verify' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Forbidden');
      expect(body.message).toContain('Access denied');
    });

    it('should reject local role from /verify with 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/incidents/${incidentId}/verify`,
        headers: { authorization: `Bearer ${localToken}` },
        payload: { notes: 'Local trying to verify' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Forbidden');
    });

    it('should allow agency role to verify incident with 200 OK', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/incidents/${incidentId}/verify`,
        headers: { authorization: `Bearer ${agencyToken}` },
        payload: { notes: 'Verified by patrol officer on scene' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.type).toBe('Feature');
      expect(body.properties.status).toBe('verified');
      expect(body.properties.verified).toBe(true);
      expect(body.properties.verificationNotes).toBe('Verified by patrol officer on scene');
      expect(body.properties.verifiedBy).toBeDefined();
      expect(body.properties.verifiedAt).toBeDefined();
    });

    it('should return 404 when agency attempts to verify non-existent incident', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/incidents/non-existent-uuid/verify',
        headers: { authorization: `Bearer ${agencyToken}` },
        payload: { notes: 'Verifying phantom incident' },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Not Found');
    });
  });
});
