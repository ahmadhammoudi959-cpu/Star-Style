ALTER TABLE "company_settings" ADD COLUMN "gls" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "delivery_method" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "pickup_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "gls_track_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "gls_status" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "label_file_id" text;