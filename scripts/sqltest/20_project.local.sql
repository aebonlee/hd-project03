-- 로컬 검증 전용 — hd-project03 (운영 실행 금지)
do $guard$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin','authenticator'))
     or exists (select 1 from pg_namespace where nspname='graphql') then
    raise exception '이 파일은 로컬 검증 전용입니다.';
  end if;
end;
$guard$;

do $t$ begin raise notice '[프로젝트] 재고보정 · 회차 계획 · 제출 검증'; end $t$;

do $t$
declare v_r boolean;
begin
  insert into vendor (biz_no, name, vendor_code) values ('1111111111','가업체','10000001')
  on conflict (biz_no) do update set vendor_code = excluded.vendor_code;
  insert into rental_item (id, biz_no, part_no, name, qty, unit_price)
  values ('IT-1','1111111111','410102-00052E','밸브', 25, 69966)
  on conflict (id) do nothing;
  insert into audit (id, biz_no, round, status)
  values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid,'1111111111','2026-08','제출')
  on conflict (id) do nothing;

  -- diff·amount_diff 는 generated 컬럼이라 넣지 않는다
  insert into audit_line (audit_id, item_id, part_no, book_qty, unit_price, actual_qty, reason)
  values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid,'IT-1','410102-00052E', 25, 69966, 24, '자가불량')
  on conflict do nothing;

  -- 보정 판단 전에는 금액이 0 이고 리스트에도 안 들어간다
  perform public._assert_eq(
    (select correction_amount from audit_line where audit_id='aaaaaaaa-0000-0000-0000-000000000001'::uuid), 0::numeric,
    '보정 판단 전에는 보정금액이 0');
  perform public._assert_eq((select count(*) from report_correction_list), 0::bigint,
    '보정 O 가 아니면 보정요청 리스트에 없다');

  -- O 로 확정하면 트리거가 금액과 조치코드를 채운다
  update audit_line set correction='O', fault='협력업체' where audit_id='aaaaaaaa-0000-0000-0000-000000000001'::uuid;
  perform public._assert_eq(
    (select correction_amount from audit_line where audit_id='aaaaaaaa-0000-0000-0000-000000000001'::uuid), -69966::numeric,
    '보정금액 = 차이 x 단가 (트리거가 계산)');
  perform public._assert_eq(
    (select action_code from audit_line where audit_id='aaaaaaaa-0000-0000-0000-000000000001'::uuid), 'Z05',
    '조치사항 코드가 기본값으로 채워진다');
  perform public._assert_eq((select count(*) from report_correction_list), 1::bigint,
    '보정 O 건이 보정요청 리스트에 취합된다');
  perform public._assert_eq((select fault from report_correction_list), '협력업체', '귀책이 실린다');

  -- 수량을 고치면 보정금액이 따라온다 (따로 저장했다면 어긋난다)
  update audit_line set actual_qty=23 where audit_id='aaaaaaaa-0000-0000-0000-000000000001'::uuid;
  perform public._assert_eq(
    (select correction_amount from audit_line where audit_id='aaaaaaaa-0000-0000-0000-000000000001'::uuid), -139932::numeric,
    '수량을 고치면 보정금액이 자동으로 따라온다');

  -- X 로 되돌리면 금액과 코드가 함께 풀린다
  update audit_line set correction='X' where audit_id='aaaaaaaa-0000-0000-0000-000000000001'::uuid;
  perform public._assert_eq(
    (select correction_amount from audit_line where audit_id='aaaaaaaa-0000-0000-0000-000000000001'::uuid), 0::numeric,
    'X 로 되돌리면 보정금액이 0 이 된다');
  perform public._assert((select action_code from audit_line where audit_id='aaaaaaaa-0000-0000-0000-000000000001'::uuid) is null,
    'X 로 되돌리면 조치코드도 지워진다');
  perform public._assert_eq((select count(*) from report_correction_list), 0::bigint,
    'X 는 보정요청 리스트에서 빠진다');

  v_r := false;
  begin
    update audit_line set correction='Y' where audit_id='aaaaaaaa-0000-0000-0000-000000000001'::uuid;
  exception when check_violation then v_r := true;
  end;
  perform public._assert(v_r, 'O·X 가 아닌 표기는 check 제약이 막는다');

  v_r := false;
  begin
    update audit_line set correction='O', fault='기타' where audit_id='aaaaaaaa-0000-0000-0000-000000000001'::uuid;
  exception when check_violation then v_r := true;
  end;
  perform public._assert(v_r, '정의되지 않은 귀책은 check 제약이 막는다');

  -- 회차 계획
  insert into round_plan (round, book_base, due_date)
  values ('2026-08','2026-07','2026-08-13')
  on conflict (round) do update set due_date = excluded.due_date;
  perform public._assert_eq((select due_date from round_plan where round='2026-08'),
    '2026-08-13'::date, '마감일이 저장된다');

  -- 결과 추출 전 점검
  perform public._assert_eq(
    (select missing_cert from report_preflight where biz_no='1111111111'), true,
    '확인서가 없으면 누락으로 잡힌다');
  insert into attachment (audit_id, file_name, storage_path) values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid,'확인서.pdf','1111111111/2026-08/확인서.pdf') on conflict do nothing;
  perform public._assert_eq(
    (select missing_cert from report_preflight where biz_no='1111111111'), false,
    '확인서를 올리면 누락이 풀린다');
end $t$;

-- 업체 격리가 정책 식에 실제로 들어 있는가
do $t$
declare v_bad text;
begin
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname in ('vendor','rental_item','audit')
     and not exists (
       select 1 from pg_policy p where p.polrelid=c.oid and p.polcmd='r'
         and pg_get_expr(p.polqual, p.polrelid) like '%current_biz_no%');
  perform public._assert(v_bad is null,
    '업체별 자료의 조회 정책에 업체 격리 조건이 있다' || coalesce(' (누락: '||v_bad||')',''));
end $t$;

-- 정리 — FK 때문에 안쪽부터 지운다
delete from audit_line where item_id = 'IT-1';
delete from attachment where audit_id = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid;
delete from audit where id = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid;
delete from rental_item where id = 'IT-1';
delete from round_plan where round = '2026-08';
delete from vendor where biz_no = '1111111111';

do $t$ begin raise notice ''; raise notice '전부 통과했습니다.'; end $t$;
