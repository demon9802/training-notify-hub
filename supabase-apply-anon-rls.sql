-- 培训通知助手 v10.2 — 开放 anon 对 tn_kv / tn-images 的读写（修正版）
-- 修正：移除 storage.objects 的 ALTER（你非该表 owner；Supabase 默认已开 RLS，无需 ALTER）
-- 执行顺序：先跑「块 1 tn_kv」→ 成功后再跑「块 2 storage」；如块 2 也报 must be owner，请走 Dashboard UI

-- ===== 块 1：tn_kv（你自己的表，务必成功，解锁数据恢复）=====
ALTER TABLE tn_kv ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anon_all_tn_kv ON tn_kv;
CREATE POLICY anon_all_tn_kv ON tn_kv
  FOR ALL TO anon
  USING (true) WITH CHECK (true);

-- ===== 块 2：storage.objects（试跑；如报 "must be owner" 请改走 Dashboard UI）=====
-- 桶已 public=true，READ 走公开 URL 不需策略；这里只补 INSERT/UPDATE/DELETE 写权限
DROP POLICY IF EXISTS anon_rw_tn_images ON storage.objects;
CREATE POLICY anon_rw_tn_images ON storage.objects
  FOR ALL TO anon
  USING (bucket_id = 'tn-images') WITH CHECK (bucket_id = 'tn-images');

-- 注意：tn_sends 不加策略，它由 GitHub Action 用 service_role 写入，本身绕过 RLS。
