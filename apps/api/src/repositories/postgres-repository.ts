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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a raw Postgres row from the incidents table to an IncidentFeature.
 * Centralised here to avoid repeating the same mapping in every method.
 */
function rowToFeature(row: Record<string, unknown>): IncidentFeature {
  const geometry = JSON.parse(row.geojson as string);
  return {
    type: 'Feature',
    id: row.id as string,
    geometry,
    properties: {
      id: row.id as string,
      title: row.title as string,
      type: row.type as IncidentFeature['properties']['type'],
      severity: row.severity as number,
      description: row.description as string,
      landmark: (row.landmark as string | null) ?? undefined,
      clientId: (row.client_id as string | null) ?? undefined,
      status: row.status as IncidentFeature['properties']['status'],
      verified: row.verified as boolean,
      source: row.source as IncidentFeature['properties']['source'],
      reportedBy: (row.reportedBy as string | null) ?? undefined,
      verifiedBy: (row.verifiedBy as string | null) ?? undefined,
      verifiedAt: row.verifiedAt ? (row.verifiedAt as Date).toISOString() : undefined,
      verificationNotes: (row.verificationNotes as string | null) ?? undefined,
      createdAt: (row.createdAt as Date).toISOString(),
      updatedAt: (row.updatedAt as Date).toISOString(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Incidents
// ─────────────────────────────────────────────────────────────────────────────

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
    // ── Idempotency: if a clientId was provided, use INSERT … ON CONFLICT DO NOTHING
    // then immediately SELECT the existing row.  The UNIQUE constraint on
    // incidents.client_id (added in the migration) enforces exactly-once storage.
    if (data.clientId) {
      const insertQuery = `
        INSERT INTO incidents (
          title, type, severity, description, status, verified, source,
          reported_by, landmark, client_id,
          location, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, 'reported', false, $5,
          $6, $7, $8,
          ST_SetSRID(ST_MakePoint($9, $10), 4326)::geography, NOW(), NOW()
        )
        ON CONFLICT (client_id) DO NOTHING
        RETURNING
          id, title, type, severity, description, landmark, client_id,
          status, verified, source,
          reported_by as "reportedBy", verified_by as "verifiedBy",
          verified_at as "verifiedAt", verification_notes as "verificationNotes",
          created_at as "createdAt", updated_at as "updatedAt",
          ST_AsGeoJSON(location::geometry) as geojson
      `;

      const insertRes = await this.pool.query(insertQuery, [
        data.title,
        data.type,
        data.severity,
        data.description,
        data.source || 'user',
        data.reportedBy || null,
        data.landmark || null,
        data.clientId,
        data.longitude,
        data.latitude,
      ]);

      if (insertRes.rowCount && insertRes.rowCount > 0) {
        return rowToFeature(insertRes.rows[0]);
      }

      // Row already exists – fetch and return it
      const selectRes = await this.pool.query(
        `SELECT
           id, title, type, severity, description, landmark, client_id,
           status, verified, source,
           reported_by as "reportedBy", verified_by as "verifiedBy",
           verified_at as "verifiedAt", verification_notes as "verificationNotes",
           created_at as "createdAt", updated_at as "updatedAt",
           ST_AsGeoJSON(location::geometry) as geojson
         FROM incidents WHERE client_id = $1`,
        [data.clientId],
      );
      return rowToFeature(selectRes.rows[0]);
    }

    // No clientId – plain insert (non-idempotent path)
    const query = `
      INSERT INTO incidents (
        title, type, severity, description, status, verified, source,
        reported_by, landmark,
        location, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, 'reported', false, $5,
        $6, $7,
        ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography, NOW(), NOW()
      )
      RETURNING
        id, title, type, severity, description, landmark, client_id,
        status, verified, source,
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
      data.landmark || null,
      data.longitude,
      data.latitude,
    ]);

    return rowToFeature(res.rows[0]);
  }

  async findById(id: string): Promise<IncidentFeature | null> {
    const query = `
      SELECT
        id, title, type, severity, description, landmark, client_id,
        status, verified, source,
        reported_by as "reportedBy", verified_by as "verifiedBy",
        verified_at as "verifiedAt", verification_notes as "verificationNotes",
        created_at as "createdAt", updated_at as "updatedAt",
        ST_AsGeoJSON(location::geometry) as geojson
      FROM incidents
      WHERE id = $1
    `;
    const res = await this.pool.query(query, [id]);
    if (res.rowCount === 0) return null;
    return rowToFeature(res.rows[0]);
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
        id, title, type, severity, description, landmark, client_id,
        status, verified, source,
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
    const features: IncidentFeature[] = res.rows.map(rowToFeature);

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
        id, title, type, severity, description, landmark, client_id,
        status, verified, source,
        reported_by as "reportedBy", verified_by as "verifiedBy",
        verified_at as "verifiedAt", verification_notes as "verificationNotes",
        created_at as "createdAt", updated_at as "updatedAt",
        ST_AsGeoJSON(location::geometry) as geojson
    `;
    const res = await this.pool.query(query, [status, agencyUserId, notes || null, id]);
    if (res.rowCount === 0) return null;
    return rowToFeature(res.rows[0]);
  }
}
