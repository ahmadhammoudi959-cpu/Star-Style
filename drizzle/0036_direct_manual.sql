ALTER TABLE "direct_order_lines" ADD COLUMN "manual" jsonb;--> statement-breakpoint
ALTER TABLE "direct_order_lines" ADD COLUMN "photo_file_id" text;--> statement-breakpoint
ALTER TABLE "offer_lines" ADD COLUMN "manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_lines" ADD COLUMN "photo_file_id" text;--> statement-breakpoint
ALTER TABLE "direct_order_lines" ADD CONSTRAINT "direct_order_lines_photo_file_id_stored_files_id_fk" FOREIGN KEY ("photo_file_id") REFERENCES "public"."stored_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_lines" ADD CONSTRAINT "offer_lines_photo_file_id_stored_files_id_fk" FOREIGN KEY ("photo_file_id") REFERENCES "public"."stored_files"("id") ON DELETE set null ON UPDATE no action;