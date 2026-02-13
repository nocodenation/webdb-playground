-- Trigger function to create a default user preference for file upload size
-- Creates a row in user_preferences with:
--   pid = id from preferences where name = 'file_upload_size'
--   uid = NEW.id (id of the created user row)
--   value = '500'
-- The function is idempotent per (pid, uid) and safely does nothing if
-- the referenced preference row doesn't exist yet.

CREATE OR REPLACE FUNCTION public.fn_set_default_file_upload_size_pref()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
v_pid bigint; -- assuming preferences.id is an integer/bigint
BEGIN
  -- Find the preference id for 'file_upload_size'
SELECT id INTO v_pid
FROM public.preferences
WHERE name = 'file_upload_size'
    LIMIT 1;

-- If the preference does not exist, do nothing
IF v_pid IS NULL THEN
    RETURN NEW;
END IF;

  -- Insert default value if it doesn't already exist for this user
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_preferences up
    WHERE up.pid = v_pid AND up.uid = NEW.id
  ) THEN
    INSERT INTO public.user_preferences(pid, uid, value)
    VALUES (v_pid, NEW.id, '500');
END IF;

RETURN NEW;
END;
$$;

-- Conditionally create the trigger on public.user AFTER INSERT.
-- The DO block guards against missing tables during initial setup.
DO $$
BEGIN
  IF to_regclass('public.user') IS NOT NULL
     AND to_regclass('public.preferences') IS NOT NULL
     AND to_regclass('public.user_preferences') IS NOT NULL THEN

    -- Drop existing trigger if present to allow idempotent re-runs
    IF EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE t.tgname = 'trg_set_default_file_upload_size_pref'
        AND n.nspname = 'public'
        AND c.relname = 'user'
    ) THEN
      EXECUTE 'DROP TRIGGER trg_set_default_file_upload_size_pref ON public.user';
END IF;

EXECUTE 'CREATE TRIGGER trg_set_default_file_upload_size_pref
             AFTER INSERT ON public.user
             FOR EACH ROW
             EXECUTE FUNCTION public.fn_set_default_file_upload_size_pref()';
END IF;
END
$$;
