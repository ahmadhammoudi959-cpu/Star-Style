CREATE TABLE "login_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	"email" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"device" text DEFAULT '' NOT NULL,
	"step" text NOT NULL,
	"ok" boolean NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_codes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "session_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "login_attempts_at" ON "login_attempts" USING btree ("at");--> statement-breakpoint
CREATE INDEX "login_attempts_user_at" ON "login_attempts" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_at" ON "login_attempts" USING btree ("ip","at");