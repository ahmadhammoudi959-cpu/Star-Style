CREATE TYPE "public"."return_condition" AS ENUM('RESTOCK', 'DAMAGED');--> statement-breakpoint
ALTER TYPE "public"."doc_kind" ADD VALUE 'RETURN';--> statement-breakpoint
CREATE TABLE "return_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"return_id" text NOT NULL,
	"position" integer NOT NULL,
	"invoice_line_id" text NOT NULL,
	"variant_id" text,
	"description" text NOT NULL,
	"qty" integer NOT NULL,
	"condition" "return_condition" DEFAULT 'RESTOCK' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"invoice_id" text NOT NULL,
	"cancellation_id" text,
	"correction_id" text,
	"customer_id" text NOT NULL,
	"reason" text DEFAULT 'other' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"credit_cents" integer DEFAULT 0 NOT NULL,
	"refund_cents" integer DEFAULT 0 NOT NULL,
	"refund_method" "payment_method",
	"refund_payment_id" text,
	"write_off_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "returns_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_cancellation_id_invoices_id_fk" FOREIGN KEY ("cancellation_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_correction_id_invoices_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "return_invoice" ON "returns" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "return_customer" ON "returns" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "return_date" ON "returns" USING btree ("date");