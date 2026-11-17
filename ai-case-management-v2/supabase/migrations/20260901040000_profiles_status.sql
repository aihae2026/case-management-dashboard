-- profiles 테이블에 status 컬럼 추가 (가입 승인 플로우)
-- 기존 멤버는 'approved', join_code로 신규 합류하면 'pending' → 관리자 승인 후 'approved'
alter table profiles
  add column if not exists status text not null default 'approved';

-- 기존 멤버 전원 approved 유지 (default 값으로 이미 처리되지만 명시)
-- 신규 join_code 경로는 앱에서 'pending'으로 직접 지정

-- 관리자가 pending → approved 업데이트할 수 있어야 함
-- 기존 profiles UPDATE 정책이 org 멤버 전체를 허용하면 OK,
-- 아니라면 아래 정책 추가:
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'profiles'
      and policyname = 'admin can update member status'
  ) then
    execute $policy$
      create policy "admin can update member status"
      on profiles for update
      using (
        org_id is not null
        and org_id in (
          select org_id from user_roles
          where user_id = auth.uid() and role = 'admin'
        )
      )
      with check (true)
    $policy$;
  end if;
end $$;
