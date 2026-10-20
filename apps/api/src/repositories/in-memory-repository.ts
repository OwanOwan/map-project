import { randomUUID } from 'crypto';
import {
  CreateIncidentInput,
  IncidentFeature,
  IncidentFeatureCollection,
  IncidentStatus,
  User,
} from '@safetymap/shared';
import {
  CreateUserData,
  IIncidentRepository,
  IncidentFilterOptions,
  IUserRepository,
} from './interfaces.js';

export class InMemoryUserRepository implements IUserRepository {
  private users: Map<string, User> = new Map();
  private emailIndex: Map<string, string> = new Map();

  async create(data: CreateUserData): Promise<User> {
    const existingId = this.emailIndex.get(data.email.toLowerCase());
    if (existingId) {
      throw new Error(`User with email ${data.email} already exists`);
    }

    const now = new Date().toISOString();
    const user: User = {
      id: randomUUID(),
      email: data.email.toLowerCase(),
      passwordHash: data.passwordHash,
      name: data.name,
      role: data.role,
      agencyId: data.agencyId,
      createdAt: now,
      updatedAt: now,
    };

    this.users.set(user.id, user);
    this.emailIndex.set(user.email, user.id);
    return { ...user };
  }

  async findByEmail(email: string): Promise<User | null> {
    const userId = this.emailIndex.get(email.toLowerCase());
    if (!userId) return null;
    const user = this.users.get(userId);
    return user ? { ...user } : null;
  }

  async findById(id: string): Promise<User | null> {
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  async clear(): Promise<void> {
    this.users.clear();
    this.emailIndex.clear();
  }
}

export class InMemoryIncidentRepository implements IIncidentRepository {
  private incidents: Map<string, IncidentFeature> = new Map();

  async create(data: CreateIncidentInput & { reportedBy?: string }): Promise<IncidentFeature> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const feature: IncidentFeature = {
      type: 'Feature',
      id,
      geometry: {
        type: 'Point',
        coordinates: [data.longitude, data.latitude],
      },
      properties: {
        id,
        title: data.title,
        type: data.type,
        severity: data.severity,
        description: data.description,
        status: 'reported',
        verified: false,
        source: data.source || 'user',
        reportedBy: data.reportedBy,
        createdAt: now,
        updatedAt: now,
      },
    };

    this.incidents.set(id, feature);
    return JSON.parse(JSON.stringify(feature));
  }

  async findById(id: string): Promise<IncidentFeature | null> {
    const item = this.incidents.get(id);
    if (!item) return null;
    return JSON.parse(JSON.stringify(item));
  }

  async findByQuery(options: IncidentFilterOptions): Promise<IncidentFeatureCollection> {
    let list = Array.from(this.incidents.values());

    // 1. Spatial bounding box filter (minLng, minLat, maxLng, maxLat)
    if (options.bbox) {
      const [minLng, minLat, maxLng, maxLat] = options.bbox
        .split(',')
        .map((p) => parseFloat(p.trim()));

      list = list.filter((item) => {
        const [lng, lat] = item.geometry.coordinates;
        return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
      });
    }

    // 2. Incident type filter
    if (options.type) {
      list = list.filter((item) => item.properties.type === options.type);
    }

    // 3. Since timestamp filter
    if (options.since) {
      const sinceDate = new Date(options.since);
      list = list.filter(
        (item) => new Date(item.properties.createdAt).getTime() >= sinceDate.getTime(),
      );
    }

    // Sort by createdAt descending
    list.sort(
      (a, b) =>
        new Date(b.properties.createdAt).getTime() - new Date(a.properties.createdAt).getTime(),
    );

    const limit = options.limit || 100;
    const paginated = list.slice(0, limit);

    return {
      type: 'FeatureCollection',
      features: JSON.parse(JSON.stringify(paginated)),
      total: list.length,
    };
  }

  async verify(
    id: string,
    agencyUserId: string,
    notes?: string,
    status: IncidentStatus = 'verified',
  ): Promise<IncidentFeature | null> {
    const item = this.incidents.get(id);
    if (!item) return null;

    const now = new Date().toISOString();
    const updated: IncidentFeature = {
      ...item,
      properties: {
        ...item.properties,
        status,
        verified: status === 'verified',
        verifiedBy: agencyUserId,
        verifiedAt: now,
        verificationNotes: notes || item.properties.verificationNotes,
        updatedAt: now,
      },
    };

    this.incidents.set(id, updated);
    return JSON.parse(JSON.stringify(updated));
  }

  async clear(): Promise<void> {
    this.incidents.clear();
  }
}
