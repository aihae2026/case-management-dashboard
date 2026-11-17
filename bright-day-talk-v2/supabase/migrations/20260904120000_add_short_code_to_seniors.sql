-- seniors 테이블에 짧은 접속 코드 추가 (예: 0001 ~ 9999)
-- 어르신마다 고유한 URL 경로 (/0001) 부여용

ALTER TABLE public.seniors
  ADD COLUMN IF NOT EXISTS short_code TEXT UNIQUE;

-- ── 자동 배정 트리거 ──────────────────────────────────────────────────────────
-- 새 seniors 행 삽입 시 사용 중이지 않은 가장 작은 4자리 숫자 코드를 배정한다.
CREATE OR REPLACE FUNCTION public.assign_senior_short_code()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_code TEXT;
BEGIN
  IF NEW.short_code IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT lpad(n::text, 4, '0') INTO v_code
  FROM generate_series(1, 9999) n
  WHERE NOT EXISTS (
    SELECT 1 FROM public.seniors WHERE short_code = lpad(n::text, 4, '0')
  )
  LIMIT 1;

  IF v_code IS NULL THEN
    RAISE EXCEPTION 'senior short_code 가 모두 소진되었습니다 (최대 9999명)';
  END IF;

  NEW.short_code := v_code;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_senior_short_code ON public.seniors;
CREATE TRIGGER trg_assign_senior_short_code
  BEFORE INSERT ON public.seniors
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_senior_short_code();

-- ── 기존 행: short_code 소급 배정 ─────────────────────────────────────────────
DO $$
DECLARE
  r RECORD;
  v_code TEXT;
BEGIN
  FOR r IN
    SELECT id FROM public.seniors WHERE short_code IS NULL ORDER BY created_at
  LOOP
    SELECT lpad(n::text, 4, '0') INTO v_code
    FROM generate_series(1, 9999) n
    WHERE NOT EXISTS (
      SELECT 1 FROM public.seniors WHERE short_code = lpad(n::text, 4, '0')
    )
    LIMIT 1;

    UPDATE public.seniors SET short_code = v_code WHERE id = r.id;
  END LOOP;
END;
$$;
