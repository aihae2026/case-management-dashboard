-- ============================================================================
-- 승인 게이트 · 0단계: 사전 점검 (읽기 전용 — 아무것도 바꾸지 않습니다)
-- Supabase SQL Editor 에 붙여넣고 Run. 결과 표 하나가 나옵니다.
-- ============================================================================
select '1. 계정 상태별 인원' as 점검,
       coalesce(status,'(null)') as 항목,
       count(*)::text as 값
from public.profiles group by status
union all
select '2. 승인 대기(pending) 계정', coalesce(email,'(이메일없음)') || ' / ' || coalesce(name,''), coalesce(org_id::text,'기관없음')
from public.profiles where status = 'pending'
union all
select '3. 기관별 관리자 수', o.name, count(r.*)::text
from public.organizations o
left join public.user_roles r on r.org_id = o.id and r.role = 'admin'
group by o.id, o.name
union all
select '4. 관리자인데 상태가 approved 가 아닌 계정(없어야 정상)', coalesce(p.email,p.id::text), p.status
from public.user_roles r join public.profiles p on p.id = r.user_id and p.org_id = r.org_id
where r.role = 'admin' and p.status <> 'approved'
union all
select '5. current_org_id() 정의에 auth.uid() 포함(true 여야 정상)', 'current_org_id',
       (pg_get_functiondef('public.current_org_id()'::regprocedure) ilike '%auth.uid()%')::text
union all
select '6. 이미 설치됐나(guard 스키마)', 'guard', (to_regnamespace('guard') is not null)::text
order by 1, 2;
