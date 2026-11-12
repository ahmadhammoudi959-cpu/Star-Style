CREATE TABLE "shop_companies" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"channel" text NOT NULL,
	"wanted" boolean DEFAULT true NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"company_id" text DEFAULT '' NOT NULL,
	"location_id" text DEFAULT '' NOT NULL,
	"contact_id" text DEFAULT '' NOT NULL,
	"shop_customer_id" text DEFAULT '' NOT NULL,
	"fingerprint" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shop_companies" ADD CONSTRAINT "shop_companies_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_company_customer" ON "shop_companies" USING btree ("customer_id","channel");--> statement-breakpoint
CREATE INDEX "shop_company_status" ON "shop_companies" USING btree ("status");