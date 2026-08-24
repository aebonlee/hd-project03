-- ===============================================================
-- 업체 대여 아이템 재고관리 보고서 자동화 — Supabase(Postgres) 스키마
--
-- localStorage 데모의 데이터 모델을 그대로 옮긴 운영용 스키마 + RLS 정책 초안.
-- 적용 방법: Supabase 대시보드 → SQL Editor 에 붙여넣고 실행.
-- (README의 "Supabase 전환 가이드" 참조)
-- ===============================================================

-- ---------------------------------------------------------------
-- 0. 공통: 상태 enum
-- ---------------------------------------------------------------
do $ty$ begin
  if not exists (select 1 from pg_type where typname = 'item_status') then
    create type item_status as enum ('대여중', '종료요청', '종료');
  end if;
end $ty$;
do $ty$ begin
  if not exists (select 1 from pg_type where typname = 'audit_status') then
    create type audit_status as enum ('작성중', '제출', '검토중', '승인');
  end if;
end $ty$;
do $ty$ begin
  if not exists (select 1 from pg_type where typname = 'delete_status') then
    create type delete_status as enum ('대기', '승인', '반려');
  end if;
end $ty$;
do $ty$ begin
  if not exists (select 1 from pg_type where typname = 'notify_channel') then
    create type notify_channel as enum ('이메일', '문자');
  end if;
end $ty$;

-- ---------------------------------------------------------------
-- 1. 업체 (Vendor)
--    사업자번호가 로그인 ID. Supabase Auth 사용자와 1:1 연결한다.
--    (업체 계정 발급 시 auth.users 를 생성하고 auth_user_id 에 연결)
-- ---------------------------------------------------------------
create table if not exists vendor (
  biz_no        varchar(10) primary key,          -- 사업자번호(숫자 10자리, 하이픈 제거)
  name          text not null,                    -- 업체명
  manager_name  text,                             -- 담당자명
  phone         text,
  email         text,
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),

  constraint biz_no_digits check (biz_no ~ '^[0-9]{10}$')
);

comment on table vendor is '협력업체 — 사업자번호로 로그인';

-- ---------------------------------------------------------------
-- 2. 대여 아이템 (RentalItem)
-- ---------------------------------------------------------------
create table if not exists rental_item (
  id          text primary key,                   -- 예: IT-123-001
  biz_no      varchar(10) not null references vendor (biz_no) on delete cascade,
  name        text not null,                      -- 아이템명
  spec        text,                               -- 규격
  qty         integer not null check (qty >= 0),  -- 대여수량(장부)
  unit_price  numeric(14, 0) not null check (unit_price >= 0), -- 단가(원)
  amount      numeric(14, 0) generated always as (qty * unit_price) stored, -- 금액
  rented_at   date,                               -- 대여일
  status      item_status not null default '대여중',
  created_at  timestamptz not null default now()
);

create index if not exists rental_item_biz_no_idx on rental_item (biz_no);

-- ---------------------------------------------------------------
-- 3. 실사 (Audit) — 실사 회차별 업체 제출 단위
-- ---------------------------------------------------------------
create table if not exists audit (
  id           uuid primary key default gen_random_uuid(),
  biz_no       varchar(10) not null references vendor (biz_no) on delete cascade,
  round        varchar(7) not null,               -- 실사 회차 예: '2026-08'
  status       audit_status not null default '작성중',
  submitted_at timestamptz,
  approved_at  timestamptz,
  created_at   timestamptz not null default now(),

  unique (biz_no, round)                          -- 회차당 업체별 실사 1건
);

create index if not exists audit_round_idx on audit (round);

-- ---------------------------------------------------------------
-- 4. 실사 상세 (AuditLine)
-- ---------------------------------------------------------------
create table if not exists audit_line (
  id               bigint generated always as identity primary key,
  audit_id         uuid not null references audit (id) on delete cascade,
  item_id          text not null references rental_item (id),
  book_qty         integer not null,              -- 장부수량 (실사 시점 스냅샷)
  unit_price       numeric(14, 0) not null,       -- 단가 스냅샷
  actual_qty       integer check (actual_qty >= 0),          -- 실사수량 (미입력 null)
  diff             integer generated always as (actual_qty - book_qty) stored,       -- 차이
  amount_diff      numeric(14, 0) generated always as ((actual_qty - book_qty) * unit_price) stored, -- 금액차이
  reason           text,                          -- 소명 사유
  delete_requested boolean not null default false,-- 삭제(대여 종료) 요청 여부
  delete_status    delete_status,                 -- 삭제 요청 처리 상태

  unique (audit_id, item_id),
  -- 제출 규칙 일부를 DB 차원에서도 보강:
  -- 삭제 요청 라인은 사유 필수
  constraint delete_needs_reason
    check (not delete_requested or (reason is not null and length(trim(reason)) > 0))
);

create index if not exists audit_line_audit_idx on audit_line (audit_id);

-- "불일치 라인은 소명 필수" 규칙은 제출 시점에만 강제해야 하므로(작성중엔 허용)
-- 트리거로 검증한다.
create or replace function check_submission() returns trigger
language plpgsql as $$
begin
  if new.status in ('제출', '검토중', '승인') and old.status = '작성중' then
    -- 미입력 라인 금지
    if exists (
      select 1 from audit_line l
      where l.audit_id = new.id and not l.delete_requested and l.actual_qty is null
    ) then
      raise exception '실사 수량이 입력되지 않은 아이템이 있습니다.';
    end if;
    -- 불일치인데 소명 없는 라인 금지
    if exists (
      select 1 from audit_line l
      where l.audit_id = new.id
        and not l.delete_requested
        and l.actual_qty is distinct from l.book_qty
        and (l.reason is null or length(trim(l.reason)) = 0)
    ) then
      raise exception '불일치 아이템에 소명 사유가 없습니다.';
    end if;
    -- 확인서 첨부 필수
    if not exists (select 1 from attachment a where a.audit_id = new.id) then
      raise exception '실사결과 확인서 첨부가 필요합니다.';
    end if;
    new.submitted_at := coalesce(new.submitted_at, now());
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------
-- 5. 첨부 (Attachment) — 실사결과 확인서
--    실제 파일은 Supabase Storage 버킷 'audit-certificates' 에 저장하고
--    여기에는 경로만 기록한다. (10MB / PDF·JPG·PNG 제한은 버킷 정책으로)
-- ---------------------------------------------------------------
create table if not exists attachment (
  id           bigint generated always as identity primary key,
  audit_id     uuid not null references audit (id) on delete cascade,
  file_name    text not null,
  storage_path text not null,                     -- 예: audit-certificates/{biz_no}/{round}/확인서.pdf
  size_bytes   bigint check (size_bytes <= 10 * 1024 * 1024),
  mime_type    text check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  uploaded_at  timestamptz not null default now()
);

drop trigger if exists audit_submit_check on audit;
create trigger audit_submit_check
  before update of status on audit
  for each row execute function check_submission();

-- ---------------------------------------------------------------
-- 6. 알림 로그 (Notification)
--    발송 자체는 Edge Function(이메일 API)이 수행하고 여기에 이력을 남긴다.
-- ---------------------------------------------------------------
create table if not exists notification (
  id       bigint generated always as identity primary key,
  target   text not null,                         -- 수신자 (이메일 주소 등)
  channel  notify_channel not null default '이메일',
  message  text not null,
  sent_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 7. HD 담당자 목록 (RLS에서 관리자 판별용)
-- ---------------------------------------------------------------
create table if not exists hd_manager (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  name         text,
  email        text
);

-- 현재 사용자가 HD 담당자인지
create or replace function is_hd_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from hd_manager m where m.auth_user_id = auth.uid());
$$;

-- 현재 사용자의 사업자번호 (업체 계정이 아니면 null)
create or replace function current_biz_no() returns varchar
language sql stable security definer set search_path = public as $$
  select v.biz_no from vendor v where v.auth_user_id = auth.uid();
$$;

-- ---------------------------------------------------------------
-- 8. RLS(Row Level Security) 정책 — 업체 간 데이터 절대 격리
-- ---------------------------------------------------------------
alter table vendor       enable row level security;
alter table rental_item  enable row level security;
alter table audit        enable row level security;
alter table audit_line   enable row level security;
alter table attachment   enable row level security;
alter table notification enable row level security;
alter table hd_manager   enable row level security;

-- 업체: 본인 정보만 조회, 담당자는 전체
drop policy if exists vendor_select on vendor;
create policy vendor_select on vendor for select
  using (is_hd_manager() or biz_no = current_biz_no());
drop policy if exists vendor_admin_write on vendor;
create policy vendor_admin_write on vendor for all
  using (is_hd_manager()) with check (is_hd_manager());

-- 대여 아이템: 업체는 본인 것 조회만, 담당자는 전체 관리
drop policy if exists item_select on rental_item;
create policy item_select on rental_item for select
  using (is_hd_manager() or biz_no = current_biz_no());
drop policy if exists item_admin_write on rental_item;
create policy item_admin_write on rental_item for all
  using (is_hd_manager()) with check (is_hd_manager());

-- 실사: 업체는 본인 실사만 생성/조회/수정(작성중일 때), 담당자는 전체
drop policy if exists audit_select on audit;
create policy audit_select on audit for select
  using (is_hd_manager() or biz_no = current_biz_no());
drop policy if exists audit_vendor_insert on audit;
create policy audit_vendor_insert on audit for insert
  with check (biz_no = current_biz_no());
drop policy if exists audit_vendor_update on audit;
create policy audit_vendor_update on audit for update
  using (biz_no = current_biz_no() and status in ('작성중', '제출'))
  with check (biz_no = current_biz_no());
drop policy if exists audit_admin_all on audit;
create policy audit_admin_all on audit for all
  using (is_hd_manager()) with check (is_hd_manager());

-- 실사 상세: 소속 실사를 통해 간접 격리
drop policy if exists line_select on audit_line;
create policy line_select on audit_line for select
  using (is_hd_manager() or exists (
    select 1 from audit a where a.id = audit_id and a.biz_no = current_biz_no()));
drop policy if exists line_vendor_write on audit_line;
create policy line_vendor_write on audit_line for all
  using (exists (
    select 1 from audit a
    where a.id = audit_id and a.biz_no = current_biz_no() and a.status = '작성중'))
  with check (exists (
    select 1 from audit a
    where a.id = audit_id and a.biz_no = current_biz_no() and a.status = '작성중'));
drop policy if exists line_admin_update on audit_line;
create policy line_admin_update on audit_line for update
  using (is_hd_manager()) with check (is_hd_manager()); -- 삭제 요청 승인/반려

-- 첨부: 소속 실사 기준 격리 (Storage 버킷에도 동일한 경로 기반 정책 적용)
drop policy if exists att_select on attachment;
create policy att_select on attachment for select
  using (is_hd_manager() or exists (
    select 1 from audit a where a.id = audit_id and a.biz_no = current_biz_no()));
drop policy if exists att_vendor_insert on attachment;
create policy att_vendor_insert on attachment for insert
  with check (exists (
    select 1 from audit a
    where a.id = audit_id and a.biz_no = current_biz_no() and a.status = '작성중'));

-- 알림 로그: 담당자만 열람, 기록은 서비스 롤(Edge Function)이 수행
drop policy if exists notif_admin_select on notification;
create policy notif_admin_select on notification for select using (is_hd_manager());

-- 담당자 목록: 담당자만 열람
drop policy if exists manager_select on hd_manager;
create policy manager_select on hd_manager for select using (is_hd_manager());

-- ---------------------------------------------------------------
-- 9. 보고서용 뷰 — 업체별 수량/금액 일치도
--    수량 일치도(%) = (1 - Σ|실사-장부| / Σ장부수량) × 100
--    금액 일치도(%) = (1 - Σ|금액차이| / Σ장부금액) × 100
-- ---------------------------------------------------------------
create or replace view report_vendor_summary as
select
  a.round,
  v.biz_no,
  v.name as vendor_name,
  a.status,
  a.submitted_at,
  count(*) filter (where l.actual_qty is distinct from l.book_qty) as mismatch_count,
  count(*) filter (where l.delete_requested) as delete_request_count,
  round(greatest(0, 1 - sum(abs(coalesce(l.actual_qty, l.book_qty) - l.book_qty))::numeric
        / nullif(sum(l.book_qty), 0)) * 100, 1) as qty_match_rate,
  round(greatest(0, 1 - sum(abs(coalesce(l.amount_diff, 0)))::numeric
        / nullif(sum(l.book_qty * l.unit_price), 0)) * 100, 1) as amount_match_rate
from audit a
join vendor v on v.biz_no = a.biz_no
join audit_line l on l.audit_id = a.id
where a.status <> '작성중'
group by a.round, v.biz_no, v.name, a.status, a.submitted_at;

-- ---------------------------------------------------------------
-- 10. 샘플 시드 (데모와 동일 업체 5곳 — 필요 시 실행)
-- ---------------------------------------------------------------
-- insert into vendor (biz_no, name, manager_name, phone, email) values
--   ('1234567890', '대한테크', '김민준', '010-2345-1111', 'minjun.kim@daehantech.example.com'),
--   ('2345678901', '한빛물류', '이서연', '010-3456-2222', 'seoyeon.lee@hanbit.example.com'),
--   ('3456789012', '서울정공', '박도윤', '010-4567-3333', 'doyun.park@seouljg.example.com'),
--   ('4567890123', '미래산업', '최지우', '010-5678-4444', 'jiwoo.choi@mirae.example.com'),
--   ('5678901234', '청우전자', '정하은', '010-6789-5555', 'haeun.jung@chungwoo.example.com');

-- ===============================================================
-- 10. 2026-08-24 보완 — 회차 계획 · 품번 · 재고보정
--
--     이 절은 나중에 덧붙인 것이라 alter ... if not exists 로 씁니다.
--     기존 데이터가 있는 프로젝트에서도 그대로 다시 실행할 수 있습니다.
-- ===============================================================

-- 총괄표가 품번과 업체번호로 행을 식별한다
alter table vendor      add column if not exists vendor_code varchar(20);
alter table rental_item add column if not exists part_no     varchar(40);
alter table audit_line  add column if not exists part_no     varchar(40);
create index if not exists rental_item_part_no_idx on rental_item (part_no);

-- 재고보정 — 총괄표 하단 「보정요청 리스트」로 가는 값.
-- 담당자가 검토 화면에서 확정한다. 빈 문자열 = 아직 판단 안 함.
alter table audit_line add column if not exists correction        varchar(1);
alter table audit_line add column if not exists fault             varchar(20);
alter table audit_line add column if not exists action_code       varchar(10);
alter table audit_line add column if not exists correction_amount numeric(14,2) default 0;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'audit_line_correction_chk') then
    alter table audit_line add constraint audit_line_correction_chk
      check (correction is null or correction in ('O','X',''));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'audit_line_fault_chk') then
    alter table audit_line add constraint audit_line_fault_chk
      check (fault is null or fault in ('HCE','협력업체',''));
  end if;
end;
$c$;

-- 회차 계획 — 관리자가 여는 실사 한 회차의 기준
create table if not exists round_plan (
  round                 varchar(10) primary key,     -- '2026-08'
  book_base             varchar(10),                 -- 전산재고 기준 마감월
  book_updated_at       timestamptz,
  due_date              date,                        -- 등록 마감일 (이 날까지)
  requested_at          timestamptz,                 -- 등록요청 발송 시각
  completed_notified_at timestamptz,                 -- 전원 완료 통지 시각(회차당 1회)
  created_at            timestamptz not null default now()
);

alter table round_plan enable row level security;

-- 마감일은 업체도 봐야 지각 안내가 뜬다. 고치는 것은 담당자만.
drop policy if exists round_plan_select on round_plan;
drop policy if exists round_plan_admin  on round_plan;
create policy round_plan_select on round_plan for select using (true);
create policy round_plan_admin  on round_plan for all
  using (is_hd_manager()) with check (is_hd_manager());

-- 보정금액은 저장값이 아니라 차이 × 단가다. 따로 넣으면 수량을 고친 뒤 어긋난다.
create or replace function sync_correction_amount() returns trigger
language plpgsql set search_path = public as $fn$
declare v_diff integer;
begin
  -- ⚠ diff 는 generated 컬럼이라 BEFORE 트리거 시점에는 아직 계산되지 않는다(new.diff 가 null).
  --    여기서 원본 컬럼으로 직접 계산해야 한다.
  v_diff := coalesce(new.actual_qty, 0) - coalesce(new.book_qty, 0);
  if upper(coalesce(new.correction, '')) = 'O' then
    new.correction_amount := v_diff * coalesce(new.unit_price, 0);
    if coalesce(new.action_code, '') = '' then new.action_code := 'Z05'; end if;
  else
    new.correction_amount := 0;
    new.action_code := null;
  end if;
  return new;
end;
$fn$;

drop trigger if exists audit_line_sync_correction on audit_line;
create trigger audit_line_sync_correction
  before insert or update on audit_line
  for each row execute function sync_correction_amount();

-- 총괄표 하단 「보정요청 리스트」
create or replace view report_correction_list as
select
  v.name        as vendor_name,
  v.biz_no,
  coalesce(l.part_no, i.part_no) as part_no,
  i.name        as item_name,
  l.diff        as correction_qty,
  l.correction_amount,
  l.fault,
  l.action_code,
  l.reason
from audit_line l
join audit a       on a.id = l.audit_id
join vendor v      on v.biz_no = a.biz_no
join rental_item i on i.id = l.item_id
where upper(coalesce(l.correction, '')) = 'O'
order by v.name, coalesce(l.part_no, i.part_no);

-- 결과 추출 전 점검 — 확인서 누락 / 보정 판단 대기
create or replace view report_preflight as
select
  v.biz_no,
  v.name as vendor_name,
  a.round,
  (a.id is null)                                              as not_submitted,
  (a.id is not null and t.audit_id is null)                   as missing_cert,
  coalesce(p.pending, 0)                                      as pending_correction,
  coalesce(m.mismatch, 0)                                     as mismatch
from vendor v
left join audit a on a.biz_no = v.biz_no and a.status <> '작성중'
left join (select distinct audit_id from attachment) t on t.audit_id = a.id
left join (
  select audit_id, count(*) as pending from audit_line
   where diff is not null and diff <> 0 and not delete_requested
     and coalesce(correction, '') = ''
   group by audit_id) p on p.audit_id = a.id
left join (
  select audit_id, count(*) as mismatch from audit_line
   where diff is not null and diff <> 0 and not delete_requested
   group by audit_id) m on m.audit_id = a.id;

-- 함수 실행 권한
--  ⚠ GRANT 만으로는 제한되지 않는다. Supabase 가 신규 함수마다 anon 에 EXECUTE 를
--    자동 부여하므로 PUBLIC 만 지우면 anon=X 가 남아 비로그인 호출이 뚫린다.
--    단, is_hd_manager()·current_biz_no() 는 RLS 정책 식이 쓰므로 남겨 둔다.
--    끊으면 정책 평가가 죽어 조회가 통째로 막힌다.
revoke all on function sync_correction_amount() from public, anon;
grant execute on function sync_correction_amount() to authenticated;

-- 기존 함수들도 같이 잠근다.
--  이 앱은 **비로그인으로 볼 수 있는 화면이 없다.** 그래서 RLS 판정 함수까지
--  anon 을 끊어도 되고, 끊는 편이 안전하다.
--  (공개 목록이 있는 사이트라면 판정 함수의 anon EXECUTE 를 남겨야 한다.
--   끊는 순간 비로그인 조회가 통째로 죽는다.)
revoke all on function is_hd_manager()   from public, anon;
revoke all on function current_biz_no()  from public, anon;
revoke all on function check_submission() from public, anon;

grant execute on function is_hd_manager()   to authenticated;
grant execute on function current_biz_no()  to authenticated;
-- 트리거 전용 함수는 authenticated 를 남긴다. 트리거 발화 시 호출자 EXECUTE 를
-- 검사하는지 확실치 않은데, 검사한다면 끊는 순간 제출이 막힌다.
grant execute on function check_submission() to authenticated;
