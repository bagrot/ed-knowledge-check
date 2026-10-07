create extension if not exists pgcrypto;

do $$ begin
  create type public.app_role as enum ('user', 'admin');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type public.question_type as enum ('text', 'single_choice', 'multiple_choice');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  role public.app_role not null default 'user',
  is_blocked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.categories (
  id text primary key default gen_random_uuid()::text,
  name text not null unique,
  color text not null default '#78828f',
  created_at timestamptz not null default now()
);

create table if not exists public.question_groups (
  id text primary key default gen_random_uuid()::text,
  category_id text not null references public.categories(id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now(),
  unique(category_id, name)
);

create table if not exists public.questions (
  id text primary key default gen_random_uuid()::text,
  category_id text not null references public.categories(id) on delete restrict,
  group_id text not null references public.question_groups(id) on delete restrict,
  question_text text not null,
  answer_text text not null,
  question_type public.question_type not null default 'text',
  answer_options jsonb,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.current_tests (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  question_ids text[] not null default '{}',
  generated_at timestamptz not null default now()
);

create table if not exists public.test_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  test_date date not null,
  district text not null check (district in ('ЦАО', 'САО', 'СВАО', 'ВАО', 'ЮВАО', 'ЮАО', 'ЮЗАО', 'ЗАО', 'СЗАО', 'ЗелАО', 'ТиНАО')),
  surname text not null check (char_length(trim(surname)) between 1 and 120),
  testing_kind text not null check (testing_kind in ('first', 'repeat')),
  score smallint check (score between 0 and 5),
  result_marker text generated always as (
    case when score is null then null when score >= 4 then 'green' when score = 3 then 'yellow' else 'red' end
  ) stored,
  file_path text,
  file_name text,
  file_size bigint check (file_size between 1 and 2097152),
  status text not null default 'checked' check (status in ('in_work', 'checked')),
  question_snapshot jsonb not null default '[]'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.test_results alter column score drop not null;
alter table public.test_results alter column file_path drop not null;
alter table public.test_results alter column file_name drop not null;
alter table public.test_results alter column file_size drop not null;
alter table public.test_results add column if not exists status text not null default 'checked' check (status in ('in_work', 'checked'));
alter table public.test_results add column if not exists question_snapshot jsonb not null default '[]'::jsonb;
alter table public.test_results add column if not exists deleted_at timestamptz;
alter table public.test_results drop column if exists result_marker;
alter table public.test_results add column result_marker text generated always as (
  case when score is null then null when score >= 4 then 'green' when score = 3 then 'yellow' else 'red' end
) stored;

create index if not exists test_results_user_date_idx on public.test_results(user_id, test_date desc);
create index if not exists test_results_district_date_idx on public.test_results(district, test_date desc);

create table if not exists public.retention_notifications (
  deletion_date date not null,
  days_before smallint not null,
  sent_at timestamptz not null default now(),
  primary key (deletion_date, days_before)
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    lower(coalesce(new.email, '')),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    'user'::public.app_role
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = excluded.full_name;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and not is_blocked
  );
$$;

create or replace function public.get_public_question_count()
returns bigint
language sql
stable
security definer set search_path = ''
as $$
  select count(*)::bigint
  from public.questions;
$$;

create or replace function public.get_district_ranking()
returns table (
  district text,
  total_tests bigint,
  green_count bigint,
  average_score numeric,
  green_share numeric
)
language sql
stable
security definer set search_path = ''
as $$
  select
    tr.district,
    count(*)::bigint as total_tests,
    count(*) filter (where tr.result_marker = 'green')::bigint as green_count,
    round(avg(tr.score)::numeric, 2) as average_score,
    round((count(*) filter (where tr.result_marker = 'green'))::numeric / count(*)::numeric, 4) as green_share
  from public.test_results tr
  where tr.status = 'checked' and tr.deleted_at is null
  group by tr.district
  order by green_share desc, average_score desc, total_tests desc, tr.district;
$$;

alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.question_groups enable row level security;
alter table public.questions enable row level security;
alter table public.current_tests enable row level security;
alter table public.test_results enable row level security;
alter table public.retention_notifications enable row level security;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select"
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles_admin_update" on public.profiles;
create policy "profiles_admin_update"
  on public.profiles for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "profiles_admin_delete" on public.profiles;
create policy "profiles_admin_delete"
  on public.profiles for delete to authenticated
  using (public.is_admin() and id <> auth.uid());

drop policy if exists "categories_read" on public.categories;
create policy "categories_read"
  on public.categories for select to authenticated using (true);

drop policy if exists "categories_admin_write" on public.categories;
create policy "categories_admin_write"
  on public.categories for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "groups_read" on public.question_groups;
create policy "groups_read"
  on public.question_groups for select to authenticated using (true);

drop policy if exists "groups_admin_write" on public.question_groups;
create policy "groups_admin_write"
  on public.question_groups for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "questions_read" on public.questions;
create policy "questions_read"
  on public.questions for select to authenticated
  using (is_active or public.is_admin());

drop policy if exists "questions_admin_write" on public.questions;
create policy "questions_admin_write"
  on public.questions for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "current_tests_own" on public.current_tests;
create policy "current_tests_own"
  on public.current_tests for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "test_results_select" on public.test_results;
create policy "test_results_select"
  on public.test_results for select to authenticated
  using (true);

drop policy if exists "test_results_insert" on public.test_results;
create policy "test_results_insert"
  on public.test_results for insert to authenticated
  with check ((user_id = auth.uid() or public.is_admin()) and not exists (
    select 1 from public.profiles where id = auth.uid() and is_blocked
  ));

drop policy if exists "test_results_update" on public.test_results;
create policy "test_results_update"
  on public.test_results for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "test_results_delete" on public.test_results;
create policy "test_results_delete"
  on public.test_results for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'test-answers',
  'test-answers',
  false,
  2097152,
  array['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "test_answers_select" on storage.objects;
create policy "test_answers_select"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'test-answers'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

drop policy if exists "test_answers_insert" on storage.objects;
create policy "test_answers_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'test-answers'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

drop policy if exists "test_answers_delete" on storage.objects;
create policy "test_answers_delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'test-answers'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

grant usage on schema public to authenticated;
grant select on public.categories, public.question_groups, public.questions to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.current_tests to authenticated;
grant select, insert, update, delete on public.test_results to authenticated;
grant insert, update, delete on public.categories, public.question_groups, public.questions to authenticated;
grant update, delete on public.profiles to authenticated;
revoke all on function public.get_public_question_count() from public;
grant execute on function public.get_public_question_count() to anon, authenticated;
revoke all on function public.get_district_ranking() from public;
grant execute on function public.get_district_ranking() to authenticated;
