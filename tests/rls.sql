-- Run after schema + migrations, inside BEGIN ... ROLLBACK. All fixtures roll back.
insert into auth.users(id,email,raw_user_meta_data) values
 ('10000000-0000-4000-8000-000000000001','audit-admin@example.invalid','{}'),
 ('10000000-0000-4000-8000-000000000002','audit-user@example.invalid','{}'),
 ('10000000-0000-4000-8000-000000000003','audit-other@example.invalid','{}'),
 ('10000000-0000-4000-8000-000000000004','audit-pending@example.invalid','{}');
do $$ begin
 if exists(select 1 from public.profiles where email like 'audit-%@example.invalid' and not is_blocked) then raise exception 'New users must require approval'; end if;
end $$;
update public.profiles set is_blocked=false where id in ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003');
update public.profiles set role='admin' where id='10000000-0000-4000-8000-000000000001';
insert into public.test_results(id,user_id,test_date,district,surname,testing_kind,status) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',current_date,'ЦАО','Audit own','first','in_work'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003',current_date,'ЦАО','Audit other','first','in_work');
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
do $$ begin
 if public.is_admin() or not public.is_active_user() then raise exception 'Incorrect normal-user role'; end if;
 if (select count(*) from public.test_results where id in ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002'))<>1 then raise exception 'Cross-user results exposed'; end if;
 update public.profiles set role='admin' where id=auth.uid();
 if public.is_admin() then raise exception 'Privilege escalation'; end if;
 begin
   update public.profiles set deactivated_at=now() where id=auth.uid();
   raise exception 'Lifecycle column writable';
 exception when insufficient_privilege then null; end;
 begin
   update public.test_results set file_path='10000000-0000-4000-8000-000000000003/20000000-0000-4000-8000-000000000002/123.docx' where id='20000000-0000-4000-8000-000000000001';
   raise exception 'Foreign attachment accepted';
 exception when check_violation then null; end;
 begin
   delete from public.test_results where id='20000000-0000-4000-8000-000000000001';
   raise exception 'Hard delete allowed';
 exception when insufficient_privilege then null; end;
 perform public.archive_result('20000000-0000-4000-8000-000000000001');
 if exists(select 1 from public.test_results where id='20000000-0000-4000-8000-000000000001') then raise exception 'Deleted result exposed'; end if;
 begin
   perform public.deactivate_user('10000000-0000-4000-8000-000000000003');
   raise exception 'Non-admin deactivation allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claims','{}',true);
update public.profiles set is_blocked=true where id='10000000-0000-4000-8000-000000000002';
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
do $$ begin
 if public.is_active_user() then raise exception 'Blocked account active'; end if;
 if exists(select 1 from public.test_results) or exists(select 1 from public.questions) or exists(select 1 from public.get_district_ranking()) then raise exception 'Blocked read allowed'; end if;
 begin
   insert into public.current_tests(user_id) values(auth.uid());
   raise exception 'Blocked write allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$ begin
 if not public.is_admin() then raise exception 'Admin unavailable'; end if;
 if (select count(*) from public.test_results where id in ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002'))<>2 then raise exception 'Admin archive unavailable'; end if;
 perform public.deactivate_user('10000000-0000-4000-8000-000000000003');
end $$;
reset role;
update auth.users set raw_user_meta_data='{"full_name":"Changed"}' where id='10000000-0000-4000-8000-000000000003';
do $$ begin
 if not exists(select 1 from public.profiles where id='10000000-0000-4000-8000-000000000003' and is_blocked and deactivated_at is not null) then raise exception 'Account resurrected'; end if;
 if has_function_privilege('anon','public.get_district_ranking()','execute') then raise exception 'Anon statistics allowed'; end if;
 if has_function_privilege('anon','public.deactivate_user(uuid)','execute') then raise exception 'Anon deactivation allowed'; end if;
end $$;
select 'PASS: approval, ownership, archive, escalation, path validation, block, deactivation, anonymous RPC' as security_tests;
