CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"shop_collections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_media" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"channel" "channel" NOT NULL,
	"file_id" text NOT NULL,
	"position" integer NOT NULL,
	"media_id" text DEFAULT '' NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shop_media" ADD CONSTRAINT "shop_media_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_media" ADD CONSTRAINT "shop_media_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_name_lower" ON "categories" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "shop_media_product" ON "shop_media" USING btree ("product_id","channel","position");--> statement-breakpoint
-- vorhandene Kategorien der Artikel übernehmen (je Name einmal, Groß/klein egal; Leerzeichen am Rand weg)
INSERT INTO "categories" ("id", "name") SELECT gen_random_uuid()::text, min(trim("category")) FROM "products" WHERE trim("category") <> '' GROUP BY lower(trim("category")) ON CONFLICT DO NOTHING;
