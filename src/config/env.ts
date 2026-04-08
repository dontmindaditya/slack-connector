import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),

  // Slack App Credentials
  SLACK_CLIENT_ID: z.string().min(1, 'SLACK_CLIENT_ID is required'),
  SLACK_CLIENT_SECRET: z.string().min(1, 'SLACK_CLIENT_SECRET is required'),
  SLACK_SIGNING_SECRET: z.string().min(1, 'SLACK_SIGNING_SECRET is required'),
  SLACK_BOT_SCOPES: z
    .string()
    .default(
      'channels:read,channels:history,chat:write,users:read,team:read,groups:read,groups:history'
    ),

  // Slack OAuth Redirect
  SLACK_REDIRECT_URI: z.string().url('SLACK_REDIRECT_URI must be a valid URL'),

  // Supabase
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),

  // Redis (BullMQ)
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.string().default('6379').transform(Number),
  REDIS_PASSWORD: z.string().optional(),

  // Collectium Internal API
  COLLECTIUM_API_KEY: z.string().min(32, 'COLLECTIUM_API_KEY must be at least 32 chars'),

  // App base URL
  APP_BASE_URL: z.string().url('APP_BASE_URL must be a valid URL'),

  // Optional: Encryption key for storing Slack tokens at rest
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .length(64, 'TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes)')
    .optional(),
});

// Parse and validate — crash the process on missing/invalid vars
const _parsed = envSchema.safeParse(process.env);

if (!_parsed.success) {
  console.error('❌ Invalid environment variables:');
  _parsed.error.errors.forEach((err) => {
    console.error(`  ${err.path.join('.')}: ${err.message}`);
  });
  process.exit(1);
}

export const env = _parsed.data;

// Derived constants (not from env, but computed)
export const IS_PRODUCTION = env.NODE_ENV === 'production';
export const IS_TEST = env.NODE_ENV === 'test';