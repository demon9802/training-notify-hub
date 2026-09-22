-- ============================================================================
-- 培训通知助手 · 云端定时发送调度（方案 A）
-- ============================================================================
-- 作用：用 Supabase 自带的 pg_cron 每 5 分钟调用 send-due-scheduled Edge Function，
--       由云端基础设施完成定时发送，不依赖你的电脑 / 不依赖 GitHub Action。
--
-- 前置：
--   1) 已部署 Edge Function send-due-scheduled（见 supabase/functions/send-due-scheduled/index.ts）
--   2) 已在本函数 Secrets 设置 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY
--      （SUPABASE_URL 和 SUPABASE_ANON_KEY 一般由 Supabase 运行时自动注入，
--        仅当跨环境复用或显式覆盖时才需要在 Secrets 显式设置）
--
-- 执行方式：Supabase 控制台 → SQL Editor → 粘贴本文件 → Run
-- 验证方式：select jobid, jobname, schedule, active from cron.job;
--           应能看到 send-due-scheduled / keepalive-supabase 两条 job
-- 取消调度（如需）：
--   select cron.unschedule('send-due-scheduled');
--   select cron.unschedule('keepalive-supabase');
-- ============================================================================

-- 启用扩展（pg_cron 在 2026 年起所有 Supabase 项目默认启用；pg_net 也免费可用）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 调度 1：每 5 分钟触发定时发送（主力）
select cron.schedule(
  'send-due-scheduled',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://qyxxchifknfmvvyjvoue.supabase.co/functions/v1/send-due-scheduled',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5eHhjaGlma25mbXZ2eWp2b3VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwMzA5MjEsImV4cCI6MjEwMjYwNjkyMX0.Af81xF1lj4SvYVmn8Lxq1tepBiWgZlugB7QYyhI-ULc',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);

-- 调度 2：每 12 小时保活 ping（双保险，防止免费版 7 天无活动自动暂停）
--   注：上面的 5 分钟调度本身已是高频 HTTP 活动，足以保活；此条为额外保险。
select cron.schedule(
  'keepalive-supabase',
  '23 */12 * * *',
  $$
  select net.http_post(
    url := 'https://qyxxchifknfmvvyjvoue.supabase.co/functions/v1/send-due-scheduled?ping=1',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5eHhjaGlma25mbXZ2eWp2b3VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwMzA5MjEsImV4cCI6MjEwMjYwNjkyMX0.Af81xF1lj4SvYVmn8Lxq1tepBiWgZlugB7QYyhI-ULc',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);

-- ============================================================================
-- 验证（执行完后跑以下任一条确认已生效）
-- ============================================================================
-- select jobid, jobname, schedule, active from cron.job;
-- select * from cron.job_run_details order by start_time desc limit 10;
-- ============================================================================