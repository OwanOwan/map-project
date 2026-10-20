import pg from 'pg';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

const { Pool } = pg;

const SF_BOUNDS = {
  minLng: -122.515,
  maxLng: -122.378,
  minLat: 37.708,
  maxLat: 37.81,
};

const INCIDENT_TYPES = [
  'accident',
  'hazard',
  'crime',
  'protest',
  'road_closure',
  'weather',
  'other',
] as const;

const TITLES: Record<string, string[]> = {
  accident: [
    'Multi-vehicle collision on Market St',
    'Fender bender near highway ramp',
    'Bicycle vs vehicle incident at intersection',
    'Rear-end collision during rush hour',
    'Overturned vehicle blocking two lanes',
  ],
  hazard: [
    'Pothole causing tire damage',
    'Fallen power line across street',
    'Water main break causing localized flooding',
    'Oil spill on roadway',
    'Large debris obstructing right lane',
  ],
  crime: [
    'Vehicle burglary reported',
    'Theft of personal property in transit area',
    'Vandalism to street infrastructure',
    'Shoplifting incident nearby',
    'Suspicious activity reported',
  ],
  protest: [
    'Peaceful march down Main Avenue',
    'Demonstration outside civic center',
    'Gathering causing sidewalk congestion',
    'Public rally in central plaza',
  ],
  road_closure: [
    'Road closed for scheduled utility maintenance',
    'Emergency sewer repair closure',
    'Construction crane operation',
    'Street repaving operations',
  ],
  weather: [
    'Dense fog advisory reducing visibility',
    'Localized standing water after heavy rain',
    'High wind warning causing tree branch hazards',
  ],
  other: [
    'Traffic signal malfunctioning flashing red',
    'Street festival temporary perimeter',
    'Emergency vehicle activity in progress',
  ],
};

function getRandomArbitrary(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export async function seedDatabase() {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log('🌱 Starting database seed...');
    await client.query('BEGIN');

    // 1. Create default users for each role
    const passwordHash = await bcrypt.hash('password123', 10);

    const agencyUser = await client.query(
      `
      INSERT INTO users (email, password_hash, name, role)
      VALUES ($1, $2, $3, 'agency')
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id;
    `,
      ['officer@sfsafety.gov', passwordHash, 'Officer Sarah Martinez'],
    );

    const localUser = await client.query(
      `
      INSERT INTO users (email, password_hash, name, role)
      VALUES ($1, $2, $3, 'local')
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id;
    `,
      ['alex@missiondistrict.org', passwordHash, 'Alex Wong'],
    );

    const travelerUser = await client.query(
      `
      INSERT INTO users (email, password_hash, name, role)
      VALUES ($1, $2, $3, 'traveler')
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id;
    `,
      ['jordan@traveler.io', passwordHash, 'Jordan Bell'],
    );

    const agencyId = agencyUser.rows[0]?.id;
    const localId = localUser.rows[0]?.id;
    const travelerId = travelerUser.rows[0]?.id;

    const userIds = [localId, travelerId];

    // 2. Generate 200 realistic incidents
    console.log('📍 Generating 200 realistic incidents across San Francisco...');
    const now = Date.now();

    for (let i = 0; i < 200; i++) {
      const type = INCIDENT_TYPES[Math.floor(Math.random() * INCIDENT_TYPES.length)];
      const titleList = TITLES[type] || TITLES.other;
      const title = titleList[Math.floor(Math.random() * titleList.length)];
      const severity = Math.floor(Math.random() * 5) + 1;
      const lng = getRandomArbitrary(SF_BOUNDS.minLng, SF_BOUNDS.maxLng);
      const lat = getRandomArbitrary(SF_BOUNDS.minLat, SF_BOUNDS.maxLat);
      const isVerified = Math.random() > 0.6;
      const hoursAgo = Math.floor(Math.random() * 72); // within last 3 days
      const createdAt = new Date(now - hoursAgo * 3600 * 1000);
      const reportedBy = userIds[Math.floor(Math.random() * userIds.length)];

      await client.query(
        `
        INSERT INTO incidents (
          title, type, severity, description, status, verified, source,
          reported_by, verified_by, verified_at, location, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, 'user',
          $7, $8, $9, ST_SetSRID(ST_MakePoint($10, $11), 4326)::geography, $12, $12
        );
      `,
        [
          `${title} #${i + 1}`,
          type,
          severity,
          `Automated report for incident #${i + 1}: ${title}. Travelers and locals should exercise caution in this vicinity.`,
          isVerified ? 'verified' : 'reported',
          isVerified,
          reportedBy,
          isVerified ? agencyId : null,
          isVerified ? createdAt : null,
          lng,
          lat,
          createdAt,
        ],
      );
    }

    await client.query('COMMIT');
    console.log('✅ Seed completed with 3 users and 200 realistic incidents.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seeding failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
