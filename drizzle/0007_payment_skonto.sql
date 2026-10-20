ALTER TABLE "payments" ADD COLUMN "skonto_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "skonto_net_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "skonto_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL;