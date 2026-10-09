-- A pending switch of billing period (annual -> monthly) waits for the renewal,
-- like a downgrade. Settings shows it from this column. Safe to re-run.
ALTER TABLE public.subscriptions
    ADD COLUMN IF NOT EXISTS scheduled_interval text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'subscriptions'
       AND constraint_name = 'subscriptions_scheduled_interval_valid'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_scheduled_interval_valid
      CHECK (scheduled_interval IS NULL OR scheduled_interval IN ('month', 'year'));
  END IF;
END $$;
