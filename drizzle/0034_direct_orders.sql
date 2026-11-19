CREATE TABLE "direct_order_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"position" integer NOT NULL,
	"variant_id" text,
	"description" text NOT NULL,
	"barcode" text DEFAULT '' NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"vat_rate_bp" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "direct_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"number" serial NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"street" text DEFAULT '' NOT NULL,
	"zip" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"country" text DEFAULT 'DE' NOT NULL,
	"vat_id" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"lang" text DEFAULT 'de' NOT NULL,
	"price_group" "price_group" DEFAULT 'RETAIL' NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"ip_hash" text DEFAULT '' NOT NULL,
	"customer_id" text,
	"invoice_id" text,
	"offer_id" text,
	"reject_reason" text DEFAULT '' NOT NULL,
	"handled_by" text,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "direct_orders_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "direct_link" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_order_lines" ADD CONSTRAINT "direct_order_lines_order_id_direct_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."direct_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_order_lines" ADD CONSTRAINT "direct_order_lines_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_orders" ADD CONSTRAINT "direct_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_orders" ADD CONSTRAINT "direct_orders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_orders" ADD CONSTRAINT "direct_orders_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "direct_line_order" ON "direct_order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "direct_status" ON "direct_orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "direct_email" ON "direct_orders" USING btree ("email");--> statement-breakpoint
CREATE INDEX "direct_ip" ON "direct_orders" USING btree ("ip_hash","created_at");