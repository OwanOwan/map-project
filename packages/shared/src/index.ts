import { z } from 'zod';

// ==========================================
// Roles & Users
// ==========================================
export const UserRoleSchema = z.enum(['traveler', 'local', 'agency']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name?: string;
  role: UserRole;
  agencyId?: string;
  createdAt: string;
  updatedAt: string;
}

export type SafeUser = Omit<User, 'passwordHash'>;

export const RegisterSchema = z.object({
  email: z.string().trim().email('Invalid email address').max(255),
  password: z
    .string()
    .min(6, 'Password must be at least 6 characters long')
    .max(128, 'Password must not exceed 128 characters'),
  name: z.string().trim().min(1).max(100).optional(),
  role: UserRoleSchema.default('traveler'),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: z.string().trim().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export interface AuthTokenPayload {
  userId: string;
  email: string;
  role: UserRole;
}

// ==========================================
// Incidents & GeoJSON
// ==========================================
export const IncidentTypeSchema = z.enum([
  'accident',
  'hazard',
  'crime',
  'protest',
  'road_closure',
  'weather',
  'other',
]);
export type IncidentType = z.infer<typeof IncidentTypeSchema>;

export const IncidentStatusSchema = z.enum(['reported', 'verified', 'dismissed', 'resolved']);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

export const IncidentSourceSchema = z.enum(['user', 'sensor', 'official', 'agency']);
export type IncidentSource = z.infer<typeof IncidentSourceSchema>;

export interface GeoJSONPoint {
  type: 'Point';
  coordinates: [number, number]; // [longitude, latitude]
}

export interface IncidentProperties {
  id: string;
  title: string;
  type: IncidentType;
  severity: number;
  description: string;
  /**
   * Optional free-text landmark or junction name that helps locate the incident
   * when GPS accuracy is limited (e.g. "near the Shell station at Broad St junction").
   */
  landmark?: string;
  status: IncidentStatus;
  verified: boolean;
  source: IncidentSource;
  reportedBy?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  verificationNotes?: string;
  /**
   * Client-generated idempotency key (UUID v4) echoed back by the API.
   * Allows the offline queue to match submitted reports to server responses
   * and prevents duplicate submissions on reconnect.
   */
  clientId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentFeature {
  type: 'Feature';
  id: string;
  geometry: GeoJSONPoint;
  properties: IncidentProperties;
}

export interface IncidentFeatureCollection {
  type: 'FeatureCollection';
  features: IncidentFeature[];
  total?: number;
}

export const CreateIncidentSchema = z.preprocess(
  (val: unknown) => {
    if (typeof val === 'object' && val !== null) {
      const obj = { ...(val as Record<string, unknown>) };
      // Allow location: { lat, lng } or location: { latitude, longitude } or location: { coordinates: [lng, lat] }
      if (typeof obj.location === 'object' && obj.location !== null) {
        const loc = obj.location as Record<string, unknown>;
        if (typeof loc.latitude === 'number') obj.latitude = loc.latitude;
        else if (typeof loc.lat === 'number') obj.latitude = loc.lat;

        if (typeof loc.longitude === 'number') obj.longitude = loc.longitude;
        else if (typeof loc.lng === 'number') obj.longitude = loc.lng;

        if (Array.isArray(loc.coordinates) && loc.coordinates.length >= 2) {
          obj.longitude = loc.coordinates[0];
          obj.latitude = loc.coordinates[1];
        }
      }
      return obj;
    }
    return val;
  },
  z.object({
    title: z.string().trim().min(3, 'Title must be at least 3 characters').max(120),
    type: IncidentTypeSchema,
    severity: z
      .number()
      .int('Severity must be an integer')
      .min(1, 'Severity must be between 1 and 5')
      .max(5, 'Severity must be between 1 and 5'),
    description: z.string().trim().min(5, 'Description must be at least 5 characters').max(2000),
    latitude: z
      .number()
      .min(-90, 'Latitude must be between -90 and 90')
      .max(90, 'Latitude must be between -90 and 90'),
    longitude: z
      .number()
      .min(-180, 'Longitude must be between -180 and 180')
      .max(180, 'Longitude must be between -180 and 180'),
    source: IncidentSourceSchema.optional().default('user'),
    /**
     * Optional free-text landmark or junction name (e.g. "Broad St & 5th Ave").
     * Helps rescuers locate the incident when GPS alone is insufficient.
     */
    landmark: z
      .string()
      .trim()
      .max(200, 'Landmark must not exceed 200 characters')
      .optional(),
    /**
     * Client-generated idempotency key (UUID v4).
     * The API uses this to deduplicate retried submissions from the offline queue.
     * Must be a valid UUID; if omitted the server treats the request as non-idempotent.
     */
    clientId: z
      .string()
      .uuid('clientId must be a valid UUID v4')
      .optional(),
  }),
);
export type CreateIncidentInput = z.infer<typeof CreateIncidentSchema>;

export const BBoxSchema = z.string().refine(
  (val) => {
    const parts = val.split(',').map((p) => parseFloat(p.trim()));
    if (parts.length !== 4) return false;
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (parts.some((n) => isNaN(n))) return false;
    if (minLng < -180 || minLng > 180 || maxLng < -180 || maxLng > 180) return false;
    if (minLat < -90 || minLat > 90 || maxLat < -90 || maxLat > 90) return false;
    if (minLng > maxLng || minLat > maxLat) return false;
    return true;
  },
  {
    message:
      'Invalid bbox format. Expected "minLng,minLat,maxLng,maxLat" with valid geographic coordinates where min <= max',
  },
);

export const QueryIncidentsSchema = z.object({
  bbox: BBoxSchema.optional(),
  type: IncidentTypeSchema.optional(),
  since: z
    .string()
    .optional()
    .refine(
      (val) => {
        if (!val) return true;
        const d = new Date(val);
        return !isNaN(d.getTime());
      },
      { message: 'Invalid since timestamp. Expected valid ISO-8601 date string' },
    ),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});
export type QueryIncidentsInput = z.infer<typeof QueryIncidentsSchema>;

export const IncidentIdParamSchema = z.object({
  id: z.string().trim().min(1, 'Incident ID cannot be empty'),
});
export type IncidentIdParam = z.infer<typeof IncidentIdParamSchema>;

export const VerifyIncidentSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
  status: z.enum(['verified', 'dismissed']).optional().default('verified'),
});
export type VerifyIncidentInput = z.infer<typeof VerifyIncidentSchema>;
