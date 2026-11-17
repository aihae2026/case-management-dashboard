-- Fix: new sign-ups had no row in public.profiles, so onboarding's
-- `UPDATE profiles SET org_id = ...` matched 0 rows, org_id stayed NULL, and
-- the dashboard kept bouncing back to /onboarding ("설정 완료" 후 화면 전환 안 됨).
--
-- Root cause: the on_auth_user_created trigger that auto-creates a profile was
-- not active on the remote DB. Recreate it idempotently and backfill any
-- existing auth users that are missing a profile.
-- (The app also now upserts the profile during onboarding as a safety net.)

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, name, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    NEW.email
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill: create a profile for any existing auth user that lacks one.
INSERT INTO public.profiles (id, name, email)
SELECT u.id,
       COALESCE(u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)),
       u.email
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;
