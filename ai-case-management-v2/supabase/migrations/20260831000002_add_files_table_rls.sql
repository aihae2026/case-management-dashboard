-- files 테이블: Google Drive 업로드 파일 메타데이터
-- analyze-file, upload-to-drive Edge Function에서 사용
-- 기존에 Supabase 대시보드에서 생성된 테이블을 마이그레이션으로 공식 등록

create table if not exists public.files (
  id            uuid        primary key default gen_random_uuid(),
  org_id        uuid        not null references public.organizations(id) on delete cascade,
  client_id     uuid        references public.clients(id) on delete set null,
  name          text        not null,
  drive_file_id text,
  drive_url     text,
  mime_type     text,
  size_bytes    bigint,
  uploaded_by   text,
  created_at    timestamptz default now()
);

-- RLS 활성화 (org_id 기반 기관 간 격리)
alter table public.files enable row level security;

-- 같은 기관 구성원만 조회
create policy "org members can read own files"
  on public.files for select
  using (org_id = public.current_org_id());

-- 같은 기관 구성원만 삽입
create policy "org members can insert files"
  on public.files for insert
  with check (org_id = public.current_org_id());

-- 같은 기관 구성원만 삭제
create policy "org members can delete own files"
  on public.files for delete
  using (org_id = public.current_org_id());
