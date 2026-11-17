-- care_plan_action_links
-- clients.note 내 CarePlanAction.linkedLogIds / linkedProvIds 를 별도 테이블로 추출
-- Phase 1: 테이블 생성만 (기존 코드·데이터 일절 변경 없음)
-- 롤백: DROP TABLE public.care_plan_action_links CASCADE;

-- ────────────────────────────────────────
-- 테이블
-- ────────────────────────────────────────
CREATE TABLE public.care_plan_action_links (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid        NOT NULL REFERENCES public.clients(id)        ON DELETE CASCADE,
  org_id      uuid        NOT NULL REFERENCES public.organizations(id)   ON DELETE CASCADE,
  plan_year   int         NOT NULL,
  action_id   text        NOT NULL,  -- CarePlanAction.id (note JSON 내 UUID, FK 미설정)
  link_type   text        NOT NULL CHECK (link_type IN ('log', 'prov')),
  linked_id   uuid        NOT NULL,  -- activity_logs.id 또는 provisions.id (link_type에 따라 다름)
  excluded    boolean     NOT NULL DEFAULT false,  -- excludedLogIds / excludedProvIds 대응
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT care_plan_action_links_unique
    UNIQUE (client_id, plan_year, action_id, link_type, linked_id)
);

-- ────────────────────────────────────────
-- 인덱스
-- ────────────────────────────────────────
-- 대상자+연도 기준 조회 (가장 빈번)
CREATE INDEX care_plan_action_links_client_year_idx
  ON public.care_plan_action_links (client_id, plan_year);

-- "이 상담기록/제공이력이 어떤 계획에 연동됐나?" 역방향 조회
CREATE INDEX care_plan_action_links_linked_idx
  ON public.care_plan_action_links (linked_id, link_type);

-- action 단위 조회
CREATE INDEX care_plan_action_links_action_idx
  ON public.care_plan_action_links (action_id);

-- ────────────────────────────────────────
-- GRANT (기존 테이블과 동일 패턴)
-- ────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.care_plan_action_links TO authenticated;

GRANT ALL
  ON public.care_plan_action_links TO service_role;

-- ────────────────────────────────────────
-- RLS (기존 current_org_id() 패턴 그대로)
-- ────────────────────────────────────────
ALTER TABLE public.care_plan_action_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org reads care_plan_action_links"
  ON public.care_plan_action_links FOR SELECT TO authenticated
  USING (org_id = public.current_org_id());

CREATE POLICY "org writes care_plan_action_links"
  ON public.care_plan_action_links FOR INSERT TO authenticated
  WITH CHECK (org_id = public.current_org_id());

CREATE POLICY "org updates care_plan_action_links"
  ON public.care_plan_action_links FOR UPDATE TO authenticated
  USING  (org_id = public.current_org_id())
  WITH CHECK (org_id = public.current_org_id());

CREATE POLICY "org deletes care_plan_action_links"
  ON public.care_plan_action_links FOR DELETE TO authenticated
  USING (org_id = public.current_org_id());
