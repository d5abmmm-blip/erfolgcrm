ALTER TABLE "roadmap_goals" ADD COLUMN IF NOT EXISTS "stages" jsonb DEFAULT '[]'::jsonb NOT NULL;
