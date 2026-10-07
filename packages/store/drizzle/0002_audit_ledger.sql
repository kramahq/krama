CREATE TABLE "audit_heads" (
	"chain" text PRIMARY KEY NOT NULL,
	"seq" integer NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_records" (
	"chain" text NOT NULL,
	"seq" integer NOT NULL,
	"id" text NOT NULL,
	"at" text NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"run_id" text,
	"source_event_id" text,
	"record" text NOT NULL,
	CONSTRAINT "audit_records_chain_seq_pk" PRIMARY KEY("chain","seq")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_records_source_idx" ON "audit_records" USING btree ("chain","source_event_id");--> statement-breakpoint
CREATE INDEX "audit_records_at_idx" ON "audit_records" USING btree ("chain","at");--> statement-breakpoint
CREATE INDEX "audit_records_kind_idx" ON "audit_records" USING btree ("kind","at");--> statement-breakpoint
CREATE FUNCTION audit_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
	RAISE EXCEPTION 'audit records are append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME USING ERRCODE = '55000';
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER audit_records_no_update BEFORE UPDATE ON "audit_records" FOR EACH ROW EXECUTE FUNCTION audit_refuse_change();
--> statement-breakpoint
CREATE TRIGGER audit_records_no_delete BEFORE DELETE ON "audit_records" FOR EACH ROW EXECUTE FUNCTION audit_refuse_change();
--> statement-breakpoint
CREATE TRIGGER audit_records_no_truncate BEFORE TRUNCATE ON "audit_records" FOR EACH STATEMENT EXECUTE FUNCTION audit_refuse_change();
--> statement-breakpoint
CREATE FUNCTION audit_heads_forward_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
	IF NEW.chain <> OLD.chain OR NEW.seq <= OLD.seq THEN
		RAISE EXCEPTION 'an audit head only moves forward' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER audit_heads_forward BEFORE UPDATE ON "audit_heads" FOR EACH ROW EXECUTE FUNCTION audit_heads_forward_only();
--> statement-breakpoint
CREATE TRIGGER audit_heads_no_delete BEFORE DELETE ON "audit_heads" FOR EACH ROW EXECUTE FUNCTION audit_refuse_change();
--> statement-breakpoint
CREATE TRIGGER audit_heads_no_truncate BEFORE TRUNCATE ON "audit_heads" FOR EACH STATEMENT EXECUTE FUNCTION audit_refuse_change();
