-- ============================================================
-- 培训通知助手 — Supabase 专用 schema
-- 仅在一个【新建的、独立】Supabase 项目中执行本脚本。
-- 表名前缀 tn_，与其他项目（如专家库）完全隔离，不会互相干扰。
-- ============================================================

-- 键值存储：项目 / 群通讯录 / 模板 / 应用设置 全部存这里
create table if not exists tn_kv (
  key         text primary key,
  data        jsonb not null,
  updated_at  timestamptz default now()
);

-- 发送去重锁：保证「本地 Node」与「GitHub Actions」不会重复发送同一条通知
-- id 格式 = projectId:notificationId:audience:type  (type: main | reminder1d | reminder2h)
create table if not exists tn_sends (
  id          text primary key,
  status      text default 'pending',   -- pending | claimed | sent | failed | skipped
  claimed_by  text,
  claimed_at  timestamptz,
  sent_at     timestamptz,
  last_error  text,
  updated_at  timestamptz default now()
);

-- 索引（可选，量小可不加）
create index if not exists idx_tn_kv_project on tn_kv (key) where key like 'project:%';

-- ============================================================
-- 关于「免费项目 7 天闲置自动暂停」的保活：
-- 只要本表被定期查询就不会触发暂停。GitHub Actions 定时任务（每 15~30 分钟）
-- 每次都会 SELECT tn_kv，天然构成保活 ping，无需额外操作。
-- 若暂时只用本地、不跑 Actions，可在 Supabase 后台手动点开项目保持活跃。
-- ============================================================

-- 行级安全：脚本使用 service_role key（绕过 RLS），故此处无需额外策略。
-- 若改用 anon key，请自行创建对应 RLS 策略，切勿将 service_role key 暴露到前端。
