-- Merge duplicate organizations that share the same name into a single row,
-- so everyone who signed up under the same org shares one join_code.
--
-- Background: while the onboarding "설정 완료" bug was live, each click inserted a
-- NEW organizations row (the org INSERT succeeded even though the profile update
-- failed), producing several identical-named orgs each with its own join_code.
--
-- Canonical row = the OLDEST org per name. All children (profiles/clients/logs/
-- provisions/goals/roles) are repointed to it, then the duplicate rows are deleted.
-- The surviving row keeps its original join_code, which then becomes the shared code.

-- 0) Remove diagnostic test orgs first (unique-named, created during debugging).
DELETE FROM public.organizations
WHERE name LIKE '진단테스트기관-%' OR name LIKE '업서트기관-%';

DO $$
BEGIN
  -- duplicate -> canonical (oldest) mapping
  CREATE TEMP TABLE _org_merge ON COMMIT DROP AS
  WITH canon AS (
    SELECT DISTINCT ON (name) name, id AS canonical_id
    FROM public.organizations
    ORDER BY name, created_at ASC
  )
  SELECT o.id AS dup_id, c.canonical_id
  FROM public.organizations o
  JOIN canon c ON c.name = o.name
  WHERE o.id <> c.canonical_id;

  -- repoint org-scoped data
  UPDATE public.clients       t SET org_id = m.canonical_id FROM _org_merge m WHERE t.org_id = m.dup_id;
  UPDATE public.activity_logs t SET org_id = m.canonical_id FROM _org_merge m WHERE t.org_id = m.dup_id;
  UPDATE public.provisions    t SET org_id = m.canonical_id FROM _org_merge m WHERE t.org_id = m.dup_id;
  UPDATE public.goals         t SET org_id = m.canonical_id FROM _org_merge m WHERE t.org_id = m.dup_id;
  UPDATE public.profiles      t SET org_id = m.canonical_id FROM _org_merge m WHERE t.org_id = m.dup_id;

  -- roles: drop rows that would collide on unique(user_id,org_id,role), then repoint the rest
  DELETE FROM public.user_roles r
  USING _org_merge m
  WHERE r.org_id = m.dup_id
    AND EXISTS (
      SELECT 1 FROM public.user_roles r2
      WHERE r2.user_id = r.user_id AND r2.org_id = m.canonical_id AND r2.role = r.role
    );
  UPDATE public.user_roles t SET org_id = m.canonical_id FROM _org_merge m WHERE t.org_id = m.dup_id;

  -- delete the now-empty duplicate orgs
  DELETE FROM public.organizations o USING _org_merge m WHERE o.id = m.dup_id;
END $$;
