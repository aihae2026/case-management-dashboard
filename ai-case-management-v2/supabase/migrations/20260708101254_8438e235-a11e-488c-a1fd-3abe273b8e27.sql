
-- Generator for 8-char alphanumeric codes (no confusing chars)
CREATE OR REPLACE FUNCTION public.gen_join_code()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
  i int;
BEGIN
  LOOP
    code := '';
    FOR i IN 1..8 LOOP
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.organizations WHERE join_code = code);
  END LOOP;
  RETURN code;
END;
$$;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS join_code text;

-- Backfill existing rows
UPDATE public.organizations SET join_code = public.gen_join_code() WHERE join_code IS NULL;

ALTER TABLE public.organizations
  ALTER COLUMN join_code SET NOT NULL,
  ALTER COLUMN join_code SET DEFAULT public.gen_join_code();

CREATE UNIQUE INDEX IF NOT EXISTS organizations_join_code_key ON public.organizations(join_code);

-- Function: authenticated user joins an org by code. Updates their profile.org_id.
CREATE OR REPLACE FUNCTION public.join_org_by_code(_code text)
RETURNS TABLE (id uuid, name text, org_type text, client_types text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _org record;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT o.id, o.name, o.org_type, o.client_types
    INTO _org
    FROM public.organizations o
   WHERE upper(o.join_code) = upper(trim(_code))
   LIMIT 1;

  IF _org.id IS NULL THEN
    RAISE EXCEPTION '기관 코드를 찾을 수 없습니다.';
  END IF;

  UPDATE public.profiles
     SET org_id = _org.id
   WHERE profiles.id = _uid;

  RETURN QUERY SELECT _org.id, _org.name, _org.org_type, _org.client_types;
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_org_by_code(text) TO authenticated;
