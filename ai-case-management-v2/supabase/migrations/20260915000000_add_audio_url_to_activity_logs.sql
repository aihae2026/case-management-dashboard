-- activity_logs에 음성녹음 Drive URL 컬럼 추가
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS audio_url text;
