<#
.SYNOPSIS
  수파베이스 DB 자동 덤프 스크립트
.DESCRIPTION
  schema + data 덤프를 backups/ 폴더에 날짜별로 저장.
  7일 이상 된 백업은 자동 삭제.

.SETUP (최초 1회)
  1. 환경 변수 설정 (시스템 환경변수로 영구 저장 권장):
       $env:SUPABASE_ACCESS_TOKEN = "sbp_xxxxxxxx..."
       $env:SUPABASE_DB_PASSWORD  = "your-db-password"
  2. 또는 이 스크립트 상단 $CONFIG 섹션에 직접 입력

.SCHEDULE
  작업 스케줄러에서 매일 새벽 2시 실행:
    schtasks /create /tn "SupabaseBackup" /tr "powershell -NonInteractive -File <프로젝트 경로>\scripts\backup-db.ps1" /sc daily /st 02:00 /f
#>

# ── 설정 ──────────────────────────────────────────────────────────────
$PROJECT_DIR  = Split-Path -Parent $PSScriptRoot   # scripts 폴더의 상위(프로젝트 루트)
$BACKUP_DIR   = "$PROJECT_DIR\backups"
$KEEP_DAYS    = 7       # 보관 기간 (일)

# 환경변수에서 읽음 (없으면 아래에 직접 입력)
$ACCESS_TOKEN = $env:SUPABASE_ACCESS_TOKEN
$DB_PASSWORD  = $env:SUPABASE_DB_PASSWORD

# 직접 입력 (환경변수 사용 시 빈 문자열 유지)
# $ACCESS_TOKEN = "sbp_xxxxxxxx..."
# $DB_PASSWORD  = "your-db-password"
# ─────────────────────────────────────────────────────────────────────

# 검증
if (-not $ACCESS_TOKEN) { Write-Error "SUPABASE_ACCESS_TOKEN 환경변수가 없습니다."; exit 1 }
if (-not $DB_PASSWORD)  { Write-Error "SUPABASE_DB_PASSWORD 환경변수가 없습니다."; exit 1 }

# 날짜 태그
$DATE = Get-Date -Format "yyyyMMdd_HHmm"
$SCHEMA_FILE = "$BACKUP_DIR\schema_$DATE.sql"
$DATA_FILE   = "$BACKUP_DIR\data_$DATE.sql"

Set-Location $PROJECT_DIR

Write-Host "[$DATE] 수파베이스 덤프 시작..."

# ── 1. 스키마 덤프 ───────────────────────────────────────────────────
Write-Host "  스키마 덤프 중..."
$env:SUPABASE_ACCESS_TOKEN = $ACCESS_TOKEN
npx --yes supabase db dump --linked --password $DB_PASSWORD -f $SCHEMA_FILE 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warning "스키마 덤프 실패 (exit $LASTEXITCODE)"
} else {
    $size = [math]::Round((Get-Item $SCHEMA_FILE).Length / 1KB, 1)
    Write-Host "  ✓ 스키마: $SCHEMA_FILE ($size KB)"
}

# ── 2. 데이터 덤프 ──────────────────────────────────────────────────
Write-Host "  데이터 덤프 중..."
npx --yes supabase db dump --linked --data-only --password $DB_PASSWORD -f $DATA_FILE 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warning "데이터 덤프 실패 (exit $LASTEXITCODE)"
} else {
    $size = [math]::Round((Get-Item $DATA_FILE).Length / 1KB, 1)
    Write-Host "  ✓ 데이터: $DATA_FILE ($size KB)"
}

# ── 3. 오래된 백업 정리 ─────────────────────────────────────────────
$cutoff = (Get-Date).AddDays(-$KEEP_DAYS)
$old = Get-ChildItem $BACKUP_DIR -Filter "*.sql" | Where-Object { $_.LastWriteTime -lt $cutoff }
if ($old.Count -gt 0) {
    $old | Remove-Item -Force
    Write-Host "  🗑  ${$old.Count}개 오래된 백업 삭제 ($KEEP_DAYS일 이상)"
}

Write-Host "[$DATE] 완료."
