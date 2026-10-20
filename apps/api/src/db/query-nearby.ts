import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

export async function queryNearbyIncidents() {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();

  try {
    // San Francisco Market & Powell Intersection: -122.407437, 37.784469
    const centerLng = -122.407437;
    const centerLat = 37.784469;
    const radiusMeters = 2000; // 2 km

    console.log(
      `🔍 Querying incidents within ${radiusMeters / 1000} km of (${centerLat}, ${centerLng})...`,
    );

    const query = `
      SELECT
        id,
        title,
        type,
        severity,
        status,
        verified,
        ROUND(ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)::numeric, 1) as distance_meters,
        ST_AsGeoJSON(location::geometry) as geojson,
        created_at
      FROM incidents
      WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
      ORDER BY distance_meters ASC
      LIMIT 10;
    `;

    const res = await client.query(query, [centerLng, centerLat, radiusMeters]);
    console.log(`✅ Found ${res.rowCount} incidents within 2 km:\n`);

    res.rows.forEach((row, idx) => {
      const geo = JSON.parse(row.geojson);
      console.log(
        `#${idx + 1}: [${row.type.toUpperCase()}] ${row.title} (Severity: ${row.severity}/5)`,
      );
      console.log(
        `    Distance: ${row.distance_meters}m | Verified: ${row.verified} | Coordinates: [${geo.coordinates[0]}, ${geo.coordinates[1]}]`,
      );
    });

    return res.rows;
  } catch (err) {
    console.error('❌ Spatial query failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('query-nearby.ts') || process.argv[1]?.endsWith('query-nearby.js')) {
  queryNearbyIncidents()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
