import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_SECRET: z.string().default('safetymap-super-secret-jwt-key-for-development-and-tests-2026'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  DATABASE_URL: z.string().default('postgres://postgres:postgrespassword@localhost:5432/safetymap'),
  CORS_ORIGIN: z.string().default('*'),
  RATE_LIMIT_MAX_PER_WINDOW: z.coerce.number().default(5),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000), // 1 minute
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export const env: EnvConfig = EnvSchema.parse(process.env);
