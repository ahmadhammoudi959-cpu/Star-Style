CREATE TABLE "promotion_items" (
	"promotion_id" text NOT NULL,
	"product_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotion_shops" (
	"promotion_id" text NOT NULL,
	"channel" "channel" NOT NULL,
	"banner_version" integer DEFAULT 0 NOT NULL,
	"media" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" text PRIMARY KEY NOT NULL,
	"number" serial NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"discount_bp" integer NOT NULL,
	"places" jsonb DEFAULT '["SYSTEM","DIRECT","GENERAL_SHOP","BRAND_SHOP"]'::jsonb NOT NULL,
	"price_on" boolean DEFAULT false NOT NULL,
	"price_from" date,
	"price_until" date,
	"price_live" boolean DEFAULT false NOT NULL,
	"banner_on" boolean DEFAULT false NOT NULL,
	"banner_from" date,
	"banner_until" date,
	"banner_shops" jsonb DEFAULT '["GENERAL_SHOP"]'::jsonb NOT NULL,
	"banner_place" text DEFAULT 'top' NOT NULL,
	"banner_style" integer DEFAULT 0 NOT NULL,
	"banner_copy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"banner_files" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"banner_version" integer DEFAULT 0 NOT NULL,
	"banner_job" text DEFAULT '' NOT NULL,
	"banner_error" text DEFAULT '' NOT NULL,
	"banner_started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotions_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "direct_order_lines" ADD COLUMN "promo_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_variants" ADD COLUMN "promo_compare_cents" integer;--> statement-breakpoint
ALTER TABLE "shop_variants" ADD COLUMN "pre_promo_compare_cents" integer;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "offers_collection_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "promo_banner" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "promotion_items" ADD CONSTRAINT "promotion_items_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_items" ADD CONSTRAINT "promotion_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_shops" ADD CONSTRAINT "promotion_shops_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_item_unique" ON "promotion_items" USING btree ("promotion_id","product_id");--> statement-breakpoint
CREATE INDEX "promotion_item_product" ON "promotion_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_shop_unique" ON "promotion_shops" USING btree ("promotion_id","channel");