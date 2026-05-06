// backend/src/config/env.ts
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.union([z.string(), z.number()]).transform(v => v.toString()).default('3000'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  OSRM_URL: z.string().default('http://localhost:5000/route/v1/driving'),
  DRIVER_MATCH_RADIUS_KM: z.union([z.string(), z.number()]).transform(Number).default(5),
  DRIVER_ACCEPT_TIMEOUT_MS: z.union([z.string(), z.number()]).transform(Number).default(15000),
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  GMAIL_USER_EMAIL: z.string().optional(),
  EMAIL_FROM: z.string().default('NetRide <noreply@netride.com>'),
  APP_URL: z.string().default('http://localhost:3000'),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

