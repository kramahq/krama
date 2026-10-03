CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"phase_id" text,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"supersedes" text,
	"created_at" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"at" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"run_id" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_records" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"pack_id" text NOT NULL,
	"project_id" text,
	"title" text NOT NULL,
	"created_at" text NOT NULL,
	"idempotency_key" text,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"run_id" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_entries" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"at" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "artifacts_run_idx" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "artifacts_supersedes_idx" ON "artifacts" USING btree ("supersedes");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "decisions_run_idx" ON "decisions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "decisions_status_idx" ON "decisions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "memory_scope_idx" ON "memory_records" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "memory_status_idx" ON "memory_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_pack_idx" ON "runs" USING btree ("pack_id");--> statement-breakpoint
CREATE INDEX "runs_project_idx" ON "runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "runs_created_idx" ON "runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_idem_idx" ON "runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "steps_run_idx" ON "steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "usage_run_idx" ON "usage_entries" USING btree ("run_id");