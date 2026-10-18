-- ============================================================
-- 059_stay_id_reviews.sql
--
-- A permanent history of every ID review: who approved or rejected a guest's
-- ID, when, and the reason given on a rejection. stay_guests only keeps the
-- LATEST state (a new upload clears it), so without this a caretaker could not
-- see why the form was rejected last time. Append-only: never updated, never
-- deleted. The reason is staff's own words (no ID numbers). Written server-side.
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS stay_id_reviews (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  stay_id       UUID NOT NULL REFERENCES stays(id) ON DELETE RESTRICT,
  guest_id      UUID NOT NULL REFERENCES stay_guests(id) ON DELETE RESTRICT,
  action        TEXT NOT NULL CHECK (action IN ('approved', 'rejected')),
  reason        TEXT CHECK (reason IS NULL OR char_length(reason) <= 300),
  reviewed_by   UUID,
  reviewer_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stay_id_reviews_reason_matches_action CHECK ((action = 'rejected') = (reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_stay_id_reviews_stay ON stay_id_reviews (stay_id, created_at DESC);

ALTER TABLE stay_id_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stay_id_reviews_select ON stay_id_reviews;
CREATE POLICY stay_id_reviews_select ON stay_id_reviews
  FOR SELECT USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS stay_id_reviews_no_update ON stay_id_reviews;
CREATE TRIGGER stay_id_reviews_no_update BEFORE UPDATE ON stay_id_reviews
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();
DROP TRIGGER IF EXISTS stay_id_reviews_no_delete ON stay_id_reviews;
CREATE TRIGGER stay_id_reviews_no_delete BEFORE DELETE ON stay_id_reviews
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete();
