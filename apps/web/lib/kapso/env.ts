import 'server-only';
import { z } from 'zod';

const KapsoEnvSchema = z.object({
  KAPSO_API_KEY: z.string().min(1),
  KAPSO_API_BASE_URL: z.string().url().default('https://api.kapso.ai'),
  KAPSO_PHONE_NUMBER_ID: z.string().min(1),
  KAPSO_WABA_ID: z.string().min(1),
  KAPSO_TEMPLATE_NAME: z.string().min(1),
  KAPSO_TEMPLATE_LANGUAGE: z.string().default('es_AR'),
  KAPSO_DEFAULT_COUNTRY_ISO: z.string().default('AR'),
  META_GRAPH_VERSION: z.string().default('v24.0'),
  KAPSO_WEBHOOK_SECRET: z.string().default(''),
});

type KapsoEnv = z.infer<typeof KapsoEnvSchema>;

let cached: KapsoEnv | null = null;

export function kapsoEnv(): KapsoEnv {
  if (cached) return cached;
  const parsed = KapsoEnvSchema.safeParse({
    KAPSO_API_KEY: process.env.KAPSO_API_KEY,
    KAPSO_API_BASE_URL: process.env.KAPSO_API_BASE_URL,
    KAPSO_PHONE_NUMBER_ID: process.env.KAPSO_PHONE_NUMBER_ID,
    KAPSO_WABA_ID: process.env.KAPSO_WABA_ID,
    KAPSO_TEMPLATE_NAME: process.env.KAPSO_TEMPLATE_NAME,
    KAPSO_TEMPLATE_LANGUAGE: process.env.KAPSO_TEMPLATE_LANGUAGE,
    KAPSO_DEFAULT_COUNTRY_ISO: process.env.KAPSO_DEFAULT_COUNTRY_ISO,
    META_GRAPH_VERSION: process.env.META_GRAPH_VERSION,
    KAPSO_WEBHOOK_SECRET: process.env.KAPSO_WEBHOOK_SECRET,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid Kapso env vars (set them in apps/web/.env or Vercel):\n${issues}`);
  }
  if (process.env.NODE_ENV === 'production' && !parsed.data.KAPSO_WEBHOOK_SECRET) {
    throw new Error('Invalid Kapso env vars: KAPSO_WEBHOOK_SECRET is required in production');
  }
  cached = parsed.data;
  return cached;
}
