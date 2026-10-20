import {
  CreateIncidentInput,
  IncidentFeature,
  IncidentFeatureCollection,
  IncidentStatus,
  User,
} from '@safetymap/shared';
import pg from 'pg';
import {
  CreateUserData,
  IIncidentRepository,
  IncidentFilterOptions,
  IUserRepository,
} from './interfaces.js';

const { Pool } = pg;

export class PostgresUserRepository implements IUserRepository {
  private pool: pg.Pool;

  constructor(poolOrUrl: pg.Pool | string) {
    if (typeof poolOrUrl === 'string') {
      this.pool = new Pool({ connectionString: poolOrUrl });
    } else {
      this.pool = poolOrUrl;
    }
  }

  async create(data: CreateUserData): Promise<User> {
    const query = `
      INSERT INTO users (email, password_hash, name, role, agency_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING id, email, password_hash as "passwordHash", name, role, agency_id as "agencyId", created_at as "createdAt", updated_at as "updatedAt"
    `;
    const res = await this.pool.query(query, [
      data.email.toLowerCase(),
      data.passwordHash,
      data.name || null,
      data.role,
      data.agencyId || null,
    ]);

    const row = res.rows[0];
    return {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async findByEmail(email: string): Promise<User | null> {
    const query = `
      SELECT id, email, password_hash as "passwordHash", name, role, agency_id as "agencyId", created_at as "createdAt", updated_at as "updatedAt"
      FROM users
      WHERE email = $1
    `;
    const res = await this.pool.query(query, [email.toLowerCase()]);
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async findById(id: string): Promise<User | null> {
    const query = `
      SELECT id, email, password_hash as "passwordHash", name, role, agency_id as "agencyId", created_at as "createdAt", updated_at as "updatedAt"
      FROM users
      WHERE id = $1
    `;
    const res = await this.pool.query(query, [id]);
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export class PostgresIncidentRepository implements IIncidentRepository {
  private pool: pg.Pool;

  constructor(poolOrUrl: pg.Pool | string) {
    if (typeof poolOrUrl === 'string') {
      this.pool = new Pool({ connectionString: poolOrUrl });
    } else {
      this.pool = poolOrUrl;
    }
  }

  async create(data: CreateIncidentInput & { reportedBy?: string }): Promise<IncidentFeature> {
    const query = `
      INSERT INTO incidents (
        title, type, severity, description, status, verified, source,
        reported_by, location, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, 'reported', false, $5,
        $6, ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography, NOW(), NOW()
      )
      RETURNING
        id, title, type, severity, description, status, verified, source,
        reported_by as "reportedBy", verified_by as "verifiedBy",
        verified_at as "verifiedAt", verification_notes as "verificationNotes",
        created_at as "createdAt", updated_at as "updatedAt",
        ST_AsGeoJSON(location::geometry) as geojson
    `;

    const res = await this.pool.query(query, [
      data.title,
      data.type,
      data.severity,
      data.description,
      data.source || 'user',
      data.reportedBy || null,
      data.longitude,
      data.latitude,
    ]);

    const row = res.rows[0];
    const geometry = JSON.parse(row.geojson);

    return {
      type: 'Feature',
      id: row.id,
      geometry,
      properties: {
        id: row.id,
        title: row.title,
        type: row.type,
        severity: row.severity,
        description: row.description,
        status: row.status,
        verified: row.verified,
        source: row.source,
        reportedBy: row.reportedBy,
        verifiedBy: row.verifiedBy,
        verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : undefined,
        verificationNotes: row.verificationNotes,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  }

  async findById(id: string): Promise<IncidentFeature | null> {
    const query = `
      SELECT
        id, title, type, severity, description, status, verified, source,
        reported_by as "reportedBy", verified_by as "verifiedBy",
        verified_at as "verifiedAt", verification_notes as "verificationNotes",
        created_at as "createdAt", updated_at as "updatedAt",
        ST_AsGeoJSON(location::geometry) as geojson
      FROM incidents
      WHERE id = $1
    `;
    const res = await this.pool.query(query, [id]);
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    const geometry = JSON.parse(row.geojson);

    return {
      type: 'Feature',
      id: row.id,
      geometry,
      properties: {
        id: row.id,
        title: row.title,
        type: row.type,
        severity: row.severity,
        description: row.description,
        status: row.status,
        verified: row.verified,
        source: row.source,
        reportedBy: row.reportedBy,
        verifiedBy: row.verifiedBy,
        verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : undefined,
        verificationNotes: row.verificationNotes,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  }

  async findByQuery(options: IncidentFilterOptions): Promise<IncidentFeatureCollection> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    // BBox: minLng,minLat,maxLng,maxLat
    if (options.bbox) {
      const [minLng, minLat, maxLng, maxLat] = options.bbox
        .split(',')
        .map((p) => parseFloat(p.trim()));

      conditions.push(
        `ST_Within(location::geometry, ST_MakeEnvelope($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, 4326))`,
      );
      values.push(minLng, minLat, maxLng, maxLat);
      paramIndex += 4;
    }

    if (options.type) {
      conditions.push(`type = $${paramIndex}`);
      values.push(options.type);
      paramIndex++;
    }

    if (options.since) {
      conditions.push(`created_at >= $${paramIndex}`);
      values.push(new Date(options.since));
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit || 100;

    const query = `
      SELECT
        id, title, type, severity, description, status, verified, source,
        reported_by as "reportedBy", verified_by as "verifiedBy",
        verified_at as "verifiedAt", verification_notes as "verificationNotes",
        created_at as "createdAt", updated_at as "updatedAt",
        ST_AsGeoJSON(location::geometry) as geojson
      FROM incidents
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex}
    `;
    values.push(limit);

    const res = await this.pool.query(query, values);

    const features: IncidentFeature[] = res.rows.map((row) => ({
      type: 'Feature',
      id: row.id,
      geometry: JSON.parse(row.geojson),
      properties: {
        id: row.id,
        title: row.title,
        type: row.type,
        severity: row.severity,
        description: row.description,
        status: row.status,
        verified: row.verified,
        source: row.source,
        reportedBy: row.reportedBy,
        verifiedBy: row.verifiedBy,
        verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : undefined,
        verificationNotes: row.verificationNotes,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    }));

    return {
      type: 'FeatureCollection',
      features,
      total: features.length,
    };
  }

  async verify(
    id: string,
    agencyUserId: string,
    notes?: string,
    status: IncidentStatus = 'verified',
  ): Promise<IncidentFeature | null> {
    const query = `
      UPDATE incidents
      SET
        status = $1,
        verified = ($1 = 'verified'),
        verified_by = $2,
        verified_at = NOW(),
        verification_notes = COALESCE($3, verification_notes),
        updated_at = NOW()
      WHERE id = $4
      RETURNING
        id, title, type, severity, description, status, verified, source,
        reported_by as "reportedBy", verified_by as "verifiedBy",
        verified_at as "verifiedAt", verification_notes as "verificationNotes",
        created_at as "createdAt", updated_at as "updatedAt",
        ST_AsGeoJSON(location::geometry) as geojson
    `;
    const res = await this.pool.query(query, [status, agencyUserId, notes || null, id]);
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    const geometry = JSON.parse(row.geojson);

    return {
      type: 'Feature',
      id: row.id,
      geometry,
      properties: {
        id: row.id,
        title: row.title,
        type: row.type,
        severity: row.severity,
        description: row.description,
        status: row.status,
        verified: row.verified,
        source: row.source,
        reportedBy: row.reportedBy,
        verifiedBy: row.verifiedBy,
        verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : undefined,
        verificationNotes: row.verificationNotes,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  }
}
