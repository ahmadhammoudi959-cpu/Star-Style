CREATE TABLE "shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"channel" "channel" DEFAULT 'STORE' NOT NULL,
	"external_order_id" text,
	"carrier" text NOT NULL,
	"carrier_name" text DEFAULT '' NOT NULL,
	"tracking_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tracking_url" text DEFAULT '' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shipped_on" date NOT NULL,
	"notify_customer" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'system' NOT NULL,
	"shop_fulfillment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shop_status" text DEFAULT 'none' NOT NULL,
	"shop_error" text DEFAULT '' NOT NULL,
	"shop_tries" integer DEFAULT 0 NOT NULL,
	"delivery_status" text DEFAULT '' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipment_invoice" ON "shipments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "shipment_order" ON "shipments" USING btree ("channel","external_order_id");--> statement-breakpoint
CREATE INDEX "shipment_shop_status" ON "shipments" USING btree ("shop_status");