-- Phase 2 booking-domain replacement schema.
-- The fresh pre-launch database already runs the final booking model and the
-- legacy tables were removed before this refactor landed.
--
-- This migration is intentionally a no-op so repository migration history
-- records that the final schema was already applied out of band.

select 1;
