CREATE TYPE "public"."channel" AS ENUM('BRAND_SHOP', 'GENERAL_SHOP', 'STORE');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('COMPANY', 'PERSON');--> statement-breakpoint
CREATE TYPE "public"."doc_kind" AS ENUM('OFFER', 'INVOICE', 'CANCELLATION', 'RECEIPT', 'WRITE_OFF', 'PAYMENT');--> statement-breakpoint
CREATE TYPE "public"."expense_category" AS ENUM('GOODS', 'MARKETING', 'ADVERTISING', 'STORE_SUPPLIES', 'SHIPPING', 'RENT', 'SHOP_FEES', 'SOFTWARE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('INVOICE', 'CANCELLATION');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'ISSUED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."movement_type" AS ENUM('RECEIPT', 'SALE', 'RETURN', 'WRITE_OFF', 'ADJUSTMENT', 'CANCEL');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'BANK', 'CARD', 'ONLINE');--> statement-breakpoint
CREATE TYPE "public"."price_group" AS ENUM('WHOLESALE', 'RETAIL');--> statement-breakpoint
CREATE TYPE "public"."tax_mode" AS ENUM('DOMESTIC', 'EU_REVERSE_CHARGE', 'EU_PENDING_VATID', 'EU_B2C', 'EXPORT');--> statement-breakpoint
CREATE TYPE "public"."vat_id_status" AS ENUM('NONE', 'PENDING', 'VALID', 'INVALID');--> statement-breakpoint
CREATE TYPE "public"."write_off_reason" AS ENUM('BREAKAGE', 'DAMAGE', 'EXPIRED', 'LOSS', 'OTHER');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"batch_no" text DEFAULT '' NOT NULL,
	"expiry_date" date,
	"unit_cost_cents" integer NOT NULL,
	"qty_received" integer NOT NULL,
	"qty_left" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_settings" (
	"id" text PRIMARY KEY DEFAULT 'company' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"owner" text DEFAULT '' NOT NULL,
	"street" text DEFAULT '' NOT NULL,
	"zip" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"country" text DEFAULT 'DE' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"website" text DEFAULT '' NOT NULL,
	"vat_id" text DEFAULT '' NOT NULL,
	"tax_number" text DEFAULT '' NOT NULL,
	"bank_name" text DEFAULT '' NOT NULL,
	"iban" text DEFAULT '' NOT NULL,
	"bic" text DEFAULT '' NOT NULL,
	"logo_file_id" text,
	"default_payment_days" integer DEFAULT 14 NOT NULL,
	"offer_validity_days" integer DEFAULT 14 NOT NULL,
	"invoice_footer" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"number" serial NOT NULL,
	"type" "customer_type" DEFAULT 'COMPANY' NOT NULL,
	"name" text NOT NULL,
	"contact" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"street" text DEFAULT '' NOT NULL,
	"zip" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"country" text DEFAULT 'DE' NOT NULL,
	"vat_id" text DEFAULT '' NOT NULL,
	"vat_id_status" "vat_id_status" DEFAULT 'NONE' NOT NULL,
	"vat_checked_at" timestamp with time zone,
	"price_group" "price_group" DEFAULT 'WHOLESALE' NOT NULL,
	"credit_limit_cents" integer,
	"payment_term_days" integer,
	"notes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"supplier_id" text,
	"vendor_name" text DEFAULT '' NOT NULL,
	"vendor_country" text DEFAULT 'DE' NOT NULL,
	"invoice_no" text DEFAULT '' NOT NULL,
	"category" "expense_category" NOT NULL,
	"net_cents" integer NOT NULL,
	"vat_cents" integer DEFAULT 0 NOT NULL,
	"gross_cents" integer NOT NULL,
	"vat_rate_bp" integer DEFAULT 1900 NOT NULL,
	"reverse_charge" boolean DEFAULT false NOT NULL,
	"paid" boolean DEFAULT true NOT NULL,
	"paid_at" date,
	"file_id" text,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"supplier_id" text,
	"date" date NOT NULL,
	"supplier_invoice_no" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipts_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "installments" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"due_date" date NOT NULL,
	"amount_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"position" integer NOT NULL,
	"variant_id" text,
	"description" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"vat_rate_bp" integer DEFAULT 1900 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"vat_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text,
	"kind" "invoice_kind" DEFAULT 'INVOICE' NOT NULL,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"cancels_invoice_id" text,
	"replaces_invoice_id" text,
	"offer_id" text,
	"customer_id" text NOT NULL,
	"channel" "channel" DEFAULT 'STORE' NOT NULL,
	"external_order_id" text,
	"issue_date" date,
	"delivery_date" date,
	"due_date" date,
	"tax_mode" "tax_mode" DEFAULT 'DOMESTIC' NOT NULL,
	"oss_country" text,
	"cust_name" text DEFAULT '' NOT NULL,
	"cust_street" text DEFAULT '' NOT NULL,
	"cust_zip" text DEFAULT '' NOT NULL,
	"cust_city" text DEFAULT '' NOT NULL,
	"cust_country" text DEFAULT 'DE' NOT NULL,
	"cust_vat_id" text DEFAULT '' NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"skonto_bp" integer DEFAULT 0 NOT NULL,
	"skonto_days" integer DEFAULT 0 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"vat_cents" integer DEFAULT 0 NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"retention_of_title" boolean DEFAULT true NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"export_proof_file_id" text,
	"pdf_file_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number"),
	CONSTRAINT "invoices_cancels_invoice_id_unique" UNIQUE("cancels_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "number_sequences" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "doc_kind" NOT NULL,
	"year" integer NOT NULL,
	"next" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"offer_id" text NOT NULL,
	"position" integer NOT NULL,
	"variant_id" text,
	"description" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"vat_rate_bp" integer DEFAULT 1900 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"status" "offer_status" DEFAULT 'DRAFT' NOT NULL,
	"customer_id" text NOT NULL,
	"date" date NOT NULL,
	"valid_until" date NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"accepted_via" text DEFAULT '' NOT NULL,
	"accepted_at" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"invoice_id" text NOT NULL,
	"date" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" "payment_method" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"name_de" text NOT NULL,
	"name_nl" text DEFAULT '' NOT NULL,
	"description_de" text DEFAULT '' NOT NULL,
	"description_nl" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"supplier_id" text,
	"vat_rate_bp" integer DEFAULT 1900 NOT NULL,
	"purchase_price_cents" integer DEFAULT 0 NOT NULL,
	"wholesale_price_cents" integer DEFAULT 0 NOT NULL,
	"retail_price_cents" integer DEFAULT 0 NOT NULL,
	"image_file_id" text,
	"tracks_expiry" boolean DEFAULT false NOT NULL,
	"in_brand_shop" boolean DEFAULT false NOT NULL,
	"in_general_shop" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "receipt_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"receipt_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"batch_id" text,
	"qty" integer NOT NULL,
	"unit_cost_cents" integer NOT NULL,
	"batch_no" text DEFAULT '' NOT NULL,
	"expiry_date" date
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"qty" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"batch_id" text,
	"type" "movement_type" NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"channel" "channel",
	"ref_type" text,
	"ref_id" text,
	"note" text DEFAULT '' NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stored_files" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"street" text DEFAULT '' NOT NULL,
	"zip" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"country" text DEFAULT 'DE' NOT NULL,
	"vat_id" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"locale" text DEFAULT 'de' NOT NULL,
	"totp_secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"size" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '' NOT NULL,
	"barcode" text,
	"wholesale_price_cents" integer,
	"retail_price_cents" integer,
	"min_stock" integer DEFAULT 0 NOT NULL,
	"stock_qty" integer DEFAULT 0 NOT NULL,
	"avg_cost_cents" integer DEFAULT 0 NOT NULL,
	"shop_ref_brand" text,
	"shop_ref_general" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_barcode_unique" UNIQUE("barcode")
);
--> statement-breakpoint
CREATE TABLE "vat_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"vat_id" text NOT NULL,
	"source" text NOT NULL,
	"valid" boolean,
	"name" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"raw" jsonb,
	"error" text DEFAULT '' NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "write_off_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"write_off_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"batch_id" text,
	"qty" integer NOT NULL,
	"unit_cost_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "write_offs" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"reason" "write_off_reason" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"photo_file_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "write_offs_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_lines" ADD CONSTRAINT "offer_lines_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_lines" ADD CONSTRAINT "offer_lines_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_checks" ADD CONSTRAINT "vat_checks_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_lines" ADD CONSTRAINT "write_off_lines_write_off_id_write_offs_id_fk" FOREIGN KEY ("write_off_id") REFERENCES "public"."write_offs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_lines" ADD CONSTRAINT "write_off_lines_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_lines" ADD CONSTRAINT "write_off_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "batch_variant_expiry" ON "batches" USING btree ("variant_id","expiry_date");--> statement-breakpoint
CREATE INDEX "expense_date" ON "expenses" USING btree ("date");--> statement-breakpoint
CREATE INDEX "invoice_status_date" ON "invoices" USING btree ("status","issue_date");--> statement-breakpoint
CREATE INDEX "invoice_customer" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "number_seq_kind_year" ON "number_sequences" USING btree ("kind","year");--> statement-breakpoint
CREATE INDEX "reservation_variant_active" ON "reservations" USING btree ("variant_id","active");--> statement-breakpoint
CREATE INDEX "movement_variant_time" ON "stock_movements" USING btree ("variant_id","created_at");--> statement-breakpoint
CREATE INDEX "movement_ref" ON "stock_movements" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variant_product_size_color" ON "variants" USING btree ("product_id","size","color");