CREATE TABLE "dunnings" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"level" integer NOT NULL,
	"date" date NOT NULL,
	"open_cents" integer NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"new_due_date" date NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "initial_payment_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "initial_payment_method" "payment_method";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "cancel_reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "moved_from_invoice_id" text;--> statement-breakpoint
ALTER TABLE "dunnings" ADD CONSTRAINT "dunnings_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;