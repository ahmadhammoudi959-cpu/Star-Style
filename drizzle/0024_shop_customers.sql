CREATE TABLE "shop_customers" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"channel" text NOT NULL,
	"shop_customer_id" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"orders" integer DEFAULT 0 NOT NULL,
	"registered_at" timestamp with time zone,
	"created_customer" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "customers_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shop_customers" ADD CONSTRAINT "shop_customers_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_customer_shop_id" ON "shop_customers" USING btree ("channel","shop_customer_id");--> statement-breakpoint
CREATE INDEX "shop_customer_customer" ON "shop_customers" USING btree ("customer_id");