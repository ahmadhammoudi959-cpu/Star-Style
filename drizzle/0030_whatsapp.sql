CREATE TABLE "wa_chats" (
	"id" text PRIMARY KEY NOT NULL,
	"wa_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"customer_id" text,
	"last_message_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_text" text DEFAULT '' NOT NULL,
	"unread" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_chats_wa_id_unique" UNIQUE("wa_id")
);
--> statement-breakpoint
CREATE TABLE "wa_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"wa_message_id" text,
	"direction" text NOT NULL,
	"type" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"media_id" text,
	"media_file_id" text,
	"media_mime" text DEFAULT '' NOT NULL,
	"media_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"reply_to" text,
	"sent_by" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_messages_wa_message_id_unique" UNIQUE("wa_message_id")
);
--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "whatsapp" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_chats" ADD CONSTRAINT "wa_chats_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_chat_id_wa_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."wa_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_chat_last" ON "wa_chats" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "wa_chat_customer" ON "wa_chats" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "wa_msg_chat_at" ON "wa_messages" USING btree ("chat_id","at");