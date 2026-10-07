-- Apply once, in a transaction. Existing accounts keep their access; new accounts
-- require administrator approval (is_blocked=true) after email confirmation.
alter table public.profiles add column if not exists deactivated_at timestamptz;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id=auth.uid()
    and not is_blocked and deactivated_at is null);
$$;
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id=auth.uid()
    and role='admin' and not is_blocked and deactivated_at is null);
$$;
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- An Auth metadata update must never resurrect a removed/deactivated profile.
  if TG_OP='INSERT' then
    insert into public.profiles(id,email,full_name,role,is_blocked)
    values(new.id,lower(coalesce(new.email,'')),left(coalesce(new.raw_user_meta_data->>'full_name',''),120),'user',true)
    on conflict(id) do nothing;
  else
    update public.profiles set email=lower(coalesce(new.email,'')),
      full_name=left(coalesce(new.raw_user_meta_data->>'full_name',''),120)
      where id=new.id and deactivated_at is null;
  end if;
  return new;
end;
$$;

-- Serializes administrator changes, prevents self-lockout and lifecycle bypass.
create or replace function public.guard_profile_access()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if current_user='authenticated' or auth.uid() is not null then
    if TG_OP='DELETE' then raise exception 'Use deactivate_user'; end if;
    if old.deactivated_at is not null and new is distinct from old then
      raise exception 'Account has been deactivated';
    end if;
    if old.id=auth.uid() and (new.role<>old.role or new.is_blocked<>old.is_blocked or new.deactivated_at is distinct from old.deactivated_at) then
      raise exception 'Cannot change own access';
    end if;
  end if;
  if old.role='admin' and not old.is_blocked and old.deactivated_at is null
    and (new.role<>'admin' or new.is_blocked or new.deactivated_at is not null) then
    perform pg_advisory_xact_lock(732019);
    if not exists(select 1 from public.profiles where id<>old.id and role='admin' and not is_blocked and deactivated_at is null) then
      raise exception 'Cannot remove last active administrator';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists guard_profile_access on public.profiles;
create trigger guard_profile_access before update on public.profiles
  for each row execute function public.guard_profile_access();

create or replace function public.deactivate_user(target_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() or target_user=auth.uid() then raise exception 'Forbidden' using errcode='42501'; end if;
  update public.profiles set is_blocked=true, deactivated_at=now() where id=target_user and deactivated_at is null;
  if not found then raise exception 'Account not found'; end if;
  update auth.users set banned_until='infinity'::timestamptz where id=target_user;
  -- Keep profiles/results for audit and retention; revoke all refresh sessions.
  delete from auth.sessions where user_id=target_user;
end;
$$;
revoke delete on public.profiles from authenticated;
drop policy if exists profiles_admin_delete on public.profiles;
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles for update to authenticated
  using(public.is_admin() and deactivated_at is null) with check(public.is_admin());
-- Lifecycle column is writable only through the server function.
revoke update on public.profiles from authenticated;
grant update(role,is_blocked,full_name) on public.profiles to authenticated;

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select to authenticated using(public.is_active_user());
drop policy if exists groups_read on public.question_groups;
create policy groups_read on public.question_groups for select to authenticated using(public.is_active_user());
drop policy if exists questions_read on public.questions;
create policy questions_read on public.questions for select to authenticated using(public.is_active_user() and (is_active or public.is_admin()));
drop policy if exists current_tests_own on public.current_tests;
create policy current_tests_own on public.current_tests for all to authenticated
  using(public.is_active_user() and user_id=auth.uid()) with check(public.is_active_user() and user_id=auth.uid());

drop policy if exists test_results_select on public.test_results;
create policy test_results_select on public.test_results for select to authenticated
  using(public.is_active_user() and (public.is_admin() or (user_id=auth.uid() and deleted_at is null)));
drop policy if exists test_results_insert on public.test_results;
create policy test_results_insert on public.test_results for insert to authenticated
  with check(public.is_active_user() and deleted_at is null and (user_id=auth.uid() or public.is_admin()));
drop policy if exists test_results_update on public.test_results;
create policy test_results_update on public.test_results for update to authenticated
  using(public.is_active_user() and (public.is_admin() or (user_id=auth.uid() and deleted_at is null)))
  with check(public.is_active_user() and (user_id=auth.uid() or public.is_admin()));
-- Soft deletion only for application clients.
drop policy if exists test_results_delete on public.test_results;
revoke delete on public.test_results from authenticated;

-- PostgreSQL also checks SELECT visibility on UPDATE's new row. Archive through
-- a narrowly scoped function so hidden rows stay unreadable to their owner.
create or replace function public.archive_result(target_result uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_active_user() then raise exception 'Forbidden' using errcode='42501'; end if;
  update public.test_results set deleted_at=now() where id=target_result and deleted_at is null
    and (user_id=auth.uid() or public.is_admin());
  if not found then raise exception 'Result not found or access denied' using errcode='42501'; end if;
end;
$$;
revoke all on function public.archive_result(uuid) from public,anon;
grant execute on function public.archive_result(uuid) to authenticated;
revoke update on public.test_results from authenticated;
grant update(id,user_id,test_date,district,surname,testing_kind,score,file_path,file_name,file_size,status,question_snapshot,updated_at)
  on public.test_results to authenticated;

create or replace function public.validate_result_attachment()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP='UPDATE' and (new.id<>old.id or new.user_id<>old.user_id) then
    raise exception 'Result ownership is immutable';
  end if;
  if nullif(new.file_path,'') is not null and
    new.file_path !~ ('^' || new.user_id::text || '/' || new.id::text || '/[0-9]+[.]docx?$') then
    raise exception 'Attachment path must belong to this result' using errcode='23514';
  end if;
  if jsonb_typeof(new.question_snapshot)<>'array' or octet_length(new.question_snapshot::text)>262144 then
    raise exception 'Invalid question snapshot' using errcode='23514';
  end if;
  if new.status='checked' and (new.score is null or nullif(new.file_path,'') is null or nullif(new.file_name,'') is null or new.file_size is null) then
    raise exception 'Checked result requires score and attachment' using errcode='23514';
  end if;
  new.updated_at=now();
  return new;
end;
$$;
drop trigger if exists validate_result_attachment on public.test_results;
create trigger validate_result_attachment before insert or update on public.test_results
  for each row execute function public.validate_result_attachment();

drop policy if exists test_answers_select on storage.objects;
create policy test_answers_select on storage.objects for select to authenticated using(
  bucket_id='test-answers' and public.is_active_user() and
  (public.is_admin() or ((storage.foldername(name))[1]=auth.uid()::text and exists(
    select 1 from public.test_results r where r.file_path=name and r.deleted_at is null and r.user_id=auth.uid()))));
drop policy if exists test_answers_insert on storage.objects;
create policy test_answers_insert on storage.objects for insert to authenticated with check(
  bucket_id='test-answers' and public.is_active_user() and
  name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9]+[.]docx?$' and
  ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));
drop policy if exists test_answers_delete on storage.objects;
create policy test_answers_delete on storage.objects for delete to authenticated using(
  bucket_id='test-answers' and public.is_active_user() and
  ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));

create or replace function public.get_district_ranking()
returns table(district text,total_tests bigint,green_count bigint,average_score numeric,green_share numeric)
language sql stable security invoker set search_path = '' as $$
  select tr.district,count(*)::bigint,count(*) filter(where tr.result_marker='green')::bigint,
    round(avg(tr.score)::numeric,2),round(count(*) filter(where tr.result_marker='green')::numeric/count(*)::numeric,4)
  from public.test_results tr where public.is_active_user() and tr.status='checked' and tr.deleted_at is null
  group by tr.district order by 5 desc,4 desc,2 desc,tr.district;
$$;
revoke all on function public.get_district_ranking() from public,anon;
grant execute on function public.get_district_ranking() to authenticated;
revoke all on function public.deactivate_user(uuid) from public,anon;
grant execute on function public.deactivate_user(uuid) to authenticated;
revoke all on function public.is_active_user(),public.is_admin() from public,anon;
grant execute on function public.is_active_user(),public.is_admin() to authenticated;
revoke all on function public.handle_new_user(),public.guard_profile_access(),public.validate_result_attachment() from public,anon,authenticated;

notify pgrst, 'reload schema';
