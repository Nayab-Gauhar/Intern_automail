-- Fix: the append-only trigger on EmailEvent blocked FK cascade deletes, making
-- workspace deletion impossible.
--
-- Workspace.deletedAt is documented as a two-phase delete (mark, then a
-- MAINTENANCE job purges), and that purge cascades into EmailEvent. The original
-- trigger raised unconditionally, so the cascade failed and the whole DELETE
-- rolled back — no error the application would notice as "workspace deletion is
-- broken", just a failing purge.
--
-- The fix keeps append-only for every ordinary path while letting the deliberate
-- purge opt in through a transaction-local setting. An application bug cannot
-- trip this by accident: it has to name the setting explicitly, in the same
-- transaction.

CREATE OR REPLACE FUNCTION "emailevent_append_only"() RETURNS trigger AS $$
BEGIN
  -- Set by the purge path as: SET LOCAL instantmail.allow_event_purge = 'on';
  -- `true` as the second argument makes current_setting return NULL rather than
  -- raising when the setting was never defined.
  IF current_setting('instantmail.allow_event_purge', true) = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    'EmailEvent is append-only: % is not permitted. Analytics derive from this table, so a mutation would rewrite history. To purge a deleted workspace, set instantmail.allow_event_purge in the purging transaction.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;


-- UPDATE has no escape hatch at all, so it gets its own unconditional function.
CREATE OR REPLACE FUNCTION "emailevent_append_only_strict"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'EmailEvent is append-only: UPDATE is never permitted. Analytics derive from this table; correct a fact by appending a new event.';
END;
$$ LANGUAGE plpgsql;

-- UPDATE stays unconditionally forbidden: there is no legitimate reason to edit a
-- recorded fact, and no cascade performs one. Only DELETE needs the escape hatch.
DROP TRIGGER IF EXISTS "EmailEvent_no_update" ON "EmailEvent";

CREATE TRIGGER "EmailEvent_no_update"
  BEFORE UPDATE ON "EmailEvent"
  FOR EACH ROW EXECUTE FUNCTION "emailevent_append_only_strict"();

CREATE TRIGGER "EmailEvent_no_delete"
  BEFORE DELETE ON "EmailEvent"
  FOR EACH ROW EXECUTE FUNCTION "emailevent_append_only"();
