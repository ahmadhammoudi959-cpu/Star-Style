CREATE TYPE "public"."expense_tax_case" AS ENUM('DOMESTIC', 'EU_SERVICE', 'NON_EU_SERVICE', 'EU_GOODS', 'NO_VAT');--> statement-breakpoint
ALTER TYPE "public"."expense_category" ADD VALUE 'PACKAGING';--> statement-breakpoint
ALTER TYPE "public"."expense_category" ADD VALUE 'VEHICLE';--> statement-breakpoint
ALTER TYPE "public"."expense_category" ADD VALUE 'INSURANCE';--> statement-breakpoint
ALTER TYPE "public"."expense_category" ADD VALUE 'PHONE_INTERNET';--> statement-breakpoint
ALTER TYPE "public"."expense_category" ADD VALUE 'BANK_FEES';--> statement-breakpoint
ALTER TYPE "public"."expense_category" ADD VALUE 'CONSULTING';--> statement-breakpoint
CREATE TABLE "advisor_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"file_id" text NOT NULL,
	"bookings" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "period_locks" (
	"month" text PRIMARY KEY NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text
);
--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "datev_consultant" integer;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "datev_client" integer;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "chart_of_accounts" text DEFAULT 'SKR03' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "fiscal_year_start_month" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "account_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "advisor_email" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "tax_case" "expense_tax_case" DEFAULT 'DOMESTIC' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "channel" "channel";--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "payment_method" "payment_method";--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "number" serial NOT NULL;--> statement-breakpoint
CREATE INDEX "advisor_export_month" ON "advisor_exports" USING btree ("month");--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_number_unique" UNIQUE("number");