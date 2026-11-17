-- 어르신 생년월일 6자리(YYMMDD) 인증 컬럼 추가
ALTER TABLE seniors ADD COLUMN IF NOT EXISTS birth_code CHAR(6);

-- 인덱스: 랜딩페이지에서 생년월일로 어르신 조회 시 사용
CREATE INDEX IF NOT EXISTS seniors_birth_code_idx ON seniors (birth_code)
  WHERE birth_code IS NOT NULL;
