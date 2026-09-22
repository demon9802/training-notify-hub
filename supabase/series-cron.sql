-- ============================================================================
-- 系列推送 · 独立定时调度（与 send-due-scheduled 并行，互不干扰）
-- ============================================================================
-- 作用：用 pg_cron 每 5 分钟调用 send-due-series Edge Function。
-- 前置：
--   1) 已部署 Edge Function send-due-series（见 supabase/functions/send-due-series/index.ts）
--   2) 已在该函数 Secrets 设置 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY
-- 执行：Supabase 控制台 → SQL Editor → 粘贴本文件 → Run
-- 验证：select jobid, jobname, schedule, active from cron.job; 应能看到 send-due-series 一条
-- 取消：select cron.unschedule('send-due-series');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'send-due-series',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://qyxxchifknfmvvyjvoue.supabase.co/functions/v1/send-due-series',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5eHhjaGlma25mbXZ2eWp2b3VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwMzA5MjEsImV4cCI6MjEwMjYwNjkyMX0.Af81xF1lj4SvYVmn8Lxq1tepBiWgZlugB7QYyhI-ULc',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);
