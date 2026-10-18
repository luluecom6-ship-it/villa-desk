-- ============================================================
-- 057_stay_ref_trigger_definer.sql
--
-- Fix: "permission denied for function next_stay_ref" when a signed-in
-- admin creates a registration. The BEFORE INSERT trigger on stays runs as
-- the caller, but next_stay_ref() is (deliberately) executable by the service
-- role only. The trigger function now runs as its owner, so signed-in users
-- still cannot call next_stay_ref() directly, but saving a stay works.
-- Idempotent.
-- ============================================================
ALTER FUNCTION public.stays_before_write() SECURITY DEFINER;
ALTER FUNCTION public.stays_before_write() SET search_path = public;
