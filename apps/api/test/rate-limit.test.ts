import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import {
  InMemoryUserRepository,
  InMemoryIncidentRepository,
} from '../src/repositories/in-memory-repository.js';
import { RateLimiter } from '../src/middleware/rate-limiter.js';

describe('Rate Limiting Integration Tests (Per User & IP)', () => {
  let app: FastifyInstance;
  let rateLimiter: RateLimiter;
  let userToken: string;
  const MAX_REPORTS = 3; // Limit to 3 for fast testing

  beforeEach(async () => {
    const userRepo = new InMemoryUserRepository();
    const incidentRepo = new InMemoryIncidentRepository();
    rateLimiter = new RateLimiter({ maxRequests: MAX_REPORTS, windowMs: 10000 });

    app = await buildApp({
      userRepository: userRepo,
      incidentRepository: incidentRepo,
      rateLimiter,
    });
    await app.ready();

    // Register user to get JWT
    const regRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'reporter@test.com',
        password: 'password123',
      },
    });
    userToken = JSON.parse(regRes.body).token;
  });

  afterEach(async () => {
    await app.close();
  });

  it('should allow incident reports within the IP limit', async () => {
    for (let i = 0; i < MAX_REPORTS; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/incidents',
        headers: {
          'x-forwarded-for': '192.168.1.100',
        },
        payload: {
          title: `Report #${i + 1}`,
          type: 'accident',
          severity: 2,
          description: `Description for report #${i + 1}`,
          latitude: 37.77,
          longitude: -122.41,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.headers['x-ratelimit-remaining']).toBe(String(MAX_REPORTS - 1 - i));
    }
  });

  it('should return 429 Too Many Requests when IP limit is exceeded', async () => {
    // Fill quota
    for (let i = 0; i < MAX_REPORTS; i++) {
      await app.inject({
        method: 'POST',
        url: '/incidents',
        headers: { 'x-forwarded-for': '192.168.1.200' },
        payload: {
          title: `Report #${i + 1}`,
          type: 'hazard',
          severity: 3,
          description: 'Road hazard reported',
          latitude: 37.77,
          longitude: -122.41,
        },
      });
    }

    // Attempt (MAX_REPORTS + 1)th request
    const blockedRes = await app.inject({
      method: 'POST',
      url: '/incidents',
      headers: { 'x-forwarded-for': '192.168.1.200' },
      payload: {
        title: 'Exceeding report',
        type: 'hazard',
        severity: 3,
        description: 'Should be rate limited',
        latitude: 37.77,
        longitude: -122.41,
      },
    });

    expect(blockedRes.statusCode).toBe(429);
    const body = JSON.parse(blockedRes.body);
    expect(body.error).toBe('Too Many Requests');
    expect(body.message).toContain('Rate limit exceeded for IP');
    expect(blockedRes.headers['retry-after']).toBeDefined();
  });

  it('should enforce rate limits per authenticated user even across rotating IPs', async () => {
    // Make MAX_REPORTS from different IPs but with the SAME user token
    for (let i = 0; i < MAX_REPORTS; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/incidents',
        headers: {
          authorization: `Bearer ${userToken}`,
          'x-forwarded-for': `10.0.0.${i + 1}`, // different IP each time!
        },
        payload: {
          title: `User Report #${i + 1}`,
          type: 'crime',
          severity: 2,
          description: `User report description #${i + 1}`,
          latitude: 37.77,
          longitude: -122.41,
        },
      });
      expect(res.statusCode).toBe(201);
    }

    // Now attempt from yet another fresh IP with the same user token:
    const blockedRes = await app.inject({
      method: 'POST',
      url: '/incidents',
      headers: {
        authorization: `Bearer ${userToken}`,
        'x-forwarded-for': '10.0.0.99', // Fresh IP, but user is already capped!
      },
      payload: {
        title: 'Exceeding user quota',
        type: 'crime',
        severity: 2,
        description: 'Should be blocked by user limit',
        latitude: 37.77,
        longitude: -122.41,
      },
    });

    expect(blockedRes.statusCode).toBe(429);
    const body = JSON.parse(blockedRes.body);
    expect(body.error).toBe('Too Many Requests');
    expect(body.message).toContain('Rate limit exceeded for user');
  });

  it('should allow another user to report if previous user was capped on the same network', async () => {
    // User 1 uses up their limit with individual IP spoofing
    for (let i = 0; i < MAX_REPORTS; i++) {
      await app.inject({
        method: 'POST',
        url: '/incidents',
        headers: {
          authorization: `Bearer ${userToken}`,
          'x-forwarded-for': `203.0.113.${i + 1}`,
        },
        payload: {
          title: `User 1 report #${i + 1}`,
          type: 'weather',
          severity: 1,
          description: 'Weather notice',
          latitude: 37.77,
          longitude: -122.41,
        },
      });
    }

    // Create User 2
    const user2Res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'user2@test.com', password: 'password123' },
    });
    const user2Token = JSON.parse(user2Res.body).token;

    // User 2 from a fresh IP should succeed
    const user2Report = await app.inject({
      method: 'POST',
      url: '/incidents',
      headers: {
        authorization: `Bearer ${user2Token}`,
        'x-forwarded-for': '198.51.100.5',
      },
      payload: {
        title: 'User 2 valid report',
        type: 'weather',
        severity: 1,
        description: 'Weather alert from User 2',
        latitude: 37.77,
        longitude: -122.41,
      },
    });

    expect(user2Report.statusCode).toBe(201);
  });
});
