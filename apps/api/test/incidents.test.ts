import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { IncidentFeature } from '@safetymap/shared';
import { buildApp } from '../src/app.js';
import {
  InMemoryUserRepository,
  InMemoryIncidentRepository,
} from '../src/repositories/in-memory-repository.js';
import { RateLimiter } from '../src/middleware/rate-limiter.js';

describe('Incidents REST Endpoints & GeoJSON Map Queries', () => {
  let app: FastifyInstance;
  let incidentRepo: InMemoryIncidentRepository;

  beforeEach(async () => {
    const userRepo = new InMemoryUserRepository();
    incidentRepo = new InMemoryIncidentRepository();
    const rateLimiter = new RateLimiter({ maxRequests: 100, windowMs: 60000 });

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

  describe('POST /incidents', () => {
    it('should create an incident and return valid GeoJSON Feature', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/incidents',
        payload: {
          title: 'Fallen tree on Sunset Blvd',
          type: 'hazard',
          severity: 3,
          description: 'Large branch blocking eastbound lane',
          latitude: 37.755,
          longitude: -122.495,
          source: 'user',
        },
      });

      expect(res.statusCode).toBe(201);
      const feature = JSON.parse(res.body);

      // Verify GeoJSON structure
      expect(feature.type).toBe('Feature');
      expect(feature.id).toBeDefined();
      expect(feature.geometry.type).toBe('Point');
      expect(feature.geometry.coordinates).toEqual([-122.495, 37.755]); // [lng, lat] order

      // Verify properties
      expect(feature.properties.title).toBe('Fallen tree on Sunset Blvd');
      expect(feature.properties.type).toBe('hazard');
      expect(feature.properties.severity).toBe(3);
      expect(feature.properties.status).toBe('reported');
      expect(feature.properties.verified).toBe(false);
      expect(feature.properties.createdAt).toBeDefined();
    });

    it('should support location object format with lat and lng', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/incidents',
        payload: {
          title: 'Power outage in Mission',
          type: 'hazard',
          severity: 4,
          description: 'Traffic signals dark at multiple intersections',
          location: {
            lat: 37.76,
            lng: -122.42,
          },
        },
      });

      expect(res.statusCode).toBe(201);
      const feature = JSON.parse(res.body);
      expect(feature.geometry.coordinates).toEqual([-122.42, 37.76]);
    });
  });

  describe('GET /incidents?bbox=&type=&since= (Map GeoJSON Query)', () => {
    // SF Downtown bounding box:
    // minLng: -122.42, minLat: 37.77, maxLng: -122.39, maxLat: 37.80
    const sfDowntownBbox = '-122.42,37.77,-122.39,37.80';

    beforeEach(async () => {
      // Incident 1: INSIDE SF Downtown, accident, 1 hour ago
      await incidentRepo.create({
        title: 'Market St Crash',
        type: 'accident',
        severity: 4,
        description: 'Accident at 4th and Market',
        latitude: 37.785,
        longitude: -122.405, // Inside bbox
      });

      // Incident 2: INSIDE SF Downtown, crime, 2 hours ago
      await incidentRepo.create({
        title: 'Theft near Union Square',
        type: 'crime',
        severity: 2,
        description: 'Reported theft',
        latitude: 37.788,
        longitude: -122.408, // Inside bbox
      });

      // Incident 3: OUTSIDE bbox (Sunset district, SF): -122.49, 37.75
      await incidentRepo.create({
        title: 'Ocean Beach Hazard',
        type: 'hazard',
        severity: 1,
        description: 'Rip current warning',
        latitude: 37.75,
        longitude: -122.49, // Outside bbox
      });

      // Incident 4: OUTSIDE bbox (Oakland): -122.27, 37.80
      await incidentRepo.create({
        title: 'Oakland road work',
        type: 'road_closure',
        severity: 2,
        description: 'Paving work',
        latitude: 37.8,
        longitude: -122.27, // Outside bbox
      });
    });

    it('should return only incidents within the specified bounding box', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/incidents?bbox=${sfDowntownBbox}`,
      });

      expect(res.statusCode).toBe(200);
      const collection = JSON.parse(res.body);

      expect(collection.type).toBe('FeatureCollection');
      expect(Array.isArray(collection.features)).toBe(true);
      expect(collection.features.length).toBe(2);

      const titles = collection.features.map((f: IncidentFeature) => f.properties.title);
      expect(titles).toContain('Market St Crash');
      expect(titles).toContain('Theft near Union Square');
      expect(titles).not.toContain('Ocean Beach Hazard');
      expect(titles).not.toContain('Oakland road work');
    });

    it('should filter by bbox and incident type simultaneously', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/incidents?bbox=${sfDowntownBbox}&type=accident`,
      });

      expect(res.statusCode).toBe(200);
      const collection = JSON.parse(res.body);
      expect(collection.features.length).toBe(1);
      expect(collection.features[0].properties.title).toBe('Market St Crash');
      expect(collection.features[0].properties.type).toBe('accident');
    });

    it('should filter by since timestamp', async () => {
      const futureDate = new Date(Date.now() + 60000).toISOString();
      const resFuture = await app.inject({
        method: 'GET',
        url: `/incidents?since=${futureDate}`,
      });

      expect(resFuture.statusCode).toBe(200);
      const emptyCollection = JSON.parse(resFuture.body);
      expect(emptyCollection.features.length).toBe(0);

      const pastDate = new Date(Date.now() - 3600000).toISOString();
      const resPast = await app.inject({
        method: 'GET',
        url: `/incidents?since=${pastDate}`,
      });
      expect(resPast.statusCode).toBe(200);
      const pastCollection = JSON.parse(resPast.body);
      expect(pastCollection.features.length).toBeGreaterThan(0);
    });

    it('should return all incidents when no bbox filter is provided', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/incidents',
      });

      expect(res.statusCode).toBe(200);
      const collection = JSON.parse(res.body);
      expect(collection.type).toBe('FeatureCollection');
      expect(collection.features.length).toBe(4);
    });
  });

  describe('GET /incidents/:id', () => {
    it('should return 200 with Feature when incident exists', async () => {
      const created = await incidentRepo.create({
        title: 'Water leak',
        type: 'hazard',
        severity: 2,
        description: 'Sidewalk water leak',
        latitude: 37.77,
        longitude: -122.41,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/incidents/${created.id}`,
      });

      expect(res.statusCode).toBe(200);
      const feature = JSON.parse(res.body);
      expect(feature.id).toBe(created.id);
      expect(feature.properties.title).toBe('Water leak');
      expect(feature.geometry.coordinates).toEqual([-122.41, 37.77]);
    });

    it('should return 404 when incident does not exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/incidents/a0000000-0000-0000-0000-000000000000',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Not Found');
    });
  });
});
