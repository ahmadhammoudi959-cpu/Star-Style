CREATE TABLE "shop_events" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" "channel" NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"kind" text NOT NULL,
	"ref" text DEFAULT '' NOT NULL,
	"invoice_id" text,
	"message" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_processed" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" "channel" NOT NULL,
	"shop_variant_id" text NOT NULL,
	"inventory_item_id" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"barcode" text DEFAULT '' NOT NULL,
	"tracked" boolean DEFAULT true NOT NULL,
	"variant_id" text,
	"matched_by" text DEFAULT '' NOT NULL,
	"last_pushed_qty" integer,
	"last_pushed_at" timestamp with time zone,
	"push_error" text DEFAULT '' NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"channel" "channel" PRIMARY KEY NOT NULL,
	"domain" text DEFAULT '' NOT NULL,
	"client_id" text DEFAULT '' NOT NULL,
	"client_secret_enc" text DEFAULT '' NOT NULL,
	"static_token_enc" text DEFAULT '' NOT NULL,
	"token_enc" text DEFAULT '' NOT NULL,
	"token_expires_at" timestamp with time zone,
	"location_id" text DEFAULT '' NOT NULL,
	"location_name" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"stock_buffer" integer DEFAULT 0 NOT NULL,
	"import_test_orders" boolean DEFAULT false NOT NULL,
	"orders_since" timestamp with time zone,
	"last_order_sync" timestamp with time zone,
	"last_stock_sync" timestamp with time zone,
	"last_product_sync" timestamp with time zone,
	"webhooks_at" timestamp with time zone,
	"last_error" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_dirty" (
	"variant_id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "prices_gross" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_variants" ADD CONSTRAINT "shop_variants_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shop_event_time" ON "shop_events" USING btree ("channel","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_variant_unique" ON "shop_variants" USING btree ("channel","shop_variant_id");--> statement-breakpoint
CREATE INDEX "shop_variant_ours" ON "shop_variants" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "invoice_external" ON "invoices" USING btree ("channel","external_order_id");