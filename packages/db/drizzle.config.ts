import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/*.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Drizzle migrations and generate run as owner (erfolg).
    url:
      process.env.DATABASE_OWNER_URL ??
      'postgresql://erfolg:dev_only_password@localhost:5432/erfolg_dev',
  },
  verbose: true,
  strict: true,
});
