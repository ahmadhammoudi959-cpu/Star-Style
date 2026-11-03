ALTER TABLE "shops" ADD COLUMN "store_types" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "store_types_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "category_map" jsonb DEFAULT '{}'::jsonb NOT NULL;