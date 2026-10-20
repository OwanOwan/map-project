import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

export async function runMigrations() {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log('🔄 Running database migrations...');

    await client.query('BEGIN');

    // 1. PostGIS extension
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');

    // 2. Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100),
        role VARCHAR(20) NOT NULL DEFAULT 'traveler',
        agency_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 3. Agencies table
    await client.query(`
      CREATE TABLE IF NOT EXISTS agencies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        jurisdiction VARCHAR(255) NOT NULL,
        contact_email VARCHAR(255) NOT NULL,
        verified BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 4. Incidents table
    await client.query(`
      CREATE TABLE IF NOT EXISTS incidents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        severity INT NOT NULL CHECK (severity BETWEEN 1 AND 5),
        description TEXT NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'reported',
        verified BOOLEAN NOT NULL DEFAULT false,
        source VARCHAR(50) NOT NULL DEFAULT 'user',
        reported_by UUID REFERENCES users(id) ON DELETE SET NULL,
        verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
        verified_at TIMESTAMPTZ,
        verification_notes TEXT,
        -- Free-text landmark or junction name (offline-first location hint)
        landmark VARCHAR(200),
        -- Client-generated idempotency key (UUID v4) from the offline queue.
        -- UNIQUE enforces exactly-once storage even on retried submissions.
        client_id UUID UNIQUE,
        location GEOGRAPHY(Point, 4326) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 5. Incident verifications table
    await client.query(`
      CREATE TABLE IF NOT EXISTS incident_verifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vote VARCHAR(20) NOT NULL DEFAULT 'confirm',
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(incident_id, user_id)
      );
    `);

    // 6. Alert subscriptions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        location GEOGRAPHY(Point, 4326) NOT NULL,
        radius_meters INT NOT NULL DEFAULT 5000,
        incident_types VARCHAR(50)[] DEFAULT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 7. GiST Indexes on location columns
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_incidents_location ON incidents USING GIST (location);
      CREATE INDEX IF NOT EXISTS idx_alert_subscriptions_location ON alert_subscriptions USING GIST (location);
      CREATE INDEX IF NOT EXISTS idx_incidents_type ON incidents (type);
      CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON incidents (created_at);
      CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents (status);
      -- Partial index for fast idempotency lookups (only rows that have a client_id)
      CREATE INDEX IF NOT EXISTS idx_incidents_client_id ON incidents (client_id) WHERE client_id IS NOT NULL;
    `);

    await client.query('COMMIT');
    console.log('✅ Migrations completed successfully with PostGIS and GiST indexes.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
