CREATE TABLE "events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"at" text NOT NULL,
	"run_id" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "events_run_idx" ON "events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("type","seq");--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "events" USING btree ("subject_type","subject_id","seq");