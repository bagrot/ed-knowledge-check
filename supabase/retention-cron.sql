-- Выполните этот файл после развёртывания функции quarterly-retention.
-- Сначала один раз сохраните адрес проекта и случайный секрет в Supabase Vault:
-- select vault.create_secret('https://PROJECT.supabase.co', 'project_url');
-- select vault.create_secret('LONG_RANDOM_SECRET', 'retention_cron_secret');
-- Тот же LONG_RANDOM_SECRET добавьте в секрет RETENTION_CRON_SECRET Edge Function.

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

select cron.schedule(
  'quarterly-test-results-retention',
  '0 6 * * *', -- 09:00 по Москве (UTC+3)
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/quarterly-retention',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'retention_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
