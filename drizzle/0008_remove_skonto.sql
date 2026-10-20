ALTER TABLE "invoices" DROP COLUMN "skonto_bp";--> statement-breakpoint
ALTER TABLE "invoices" DROP COLUMN "skonto_days";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "skonto_cents";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "skonto_net_cents";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "skonto_breakdown";