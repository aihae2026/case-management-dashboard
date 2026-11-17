-- One-off cleanup: remove the throwaway orgs/users created while diagnosing the
-- "설정 완료 후 화면 전환 안 됨" bug on 2026-07-09. These would otherwise appear
-- in the sign-in org dropdown (list_org_names). Targeted strictly by the test
-- naming patterns so real data is untouched.

DELETE FROM public.organizations
WHERE name LIKE '진단테스트기관-%' OR name LIKE '업서트기관-%';

-- Test auth users (emails were all @example.com with cc-diag* / cc-fix* prefixes).
-- Their profiles/roles cascade via FK.
DELETE FROM auth.users
WHERE email LIKE 'cc-diag%@example.com'
   OR email LIKE 'cc-fix-%@example.com'
   OR email LIKE 'cc-diag-node-%@example.com';
