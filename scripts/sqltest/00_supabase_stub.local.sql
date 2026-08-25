-- ============================================================================
-- 로컬 검증 전용 — Supabase 환경 스텁
--
-- ⚠ 운영 SQL Editor 에서 실행하면 안 되는 파일입니다.
--   "실행하지 말 것"이라고 적는 대신 실행할 수 없게 가드를 넣었습니다.
--   운영에는 supabase_admin·authenticator 역할과 graphql 스키마가 있으므로
--   아래 블록이 예외를 던지고 즉시 멈춥니다.
-- ============================================================================

do $guard$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin', 'authenticator'))
     or exists (select 1 from pg_namespace where nspname = 'graphql') then
    raise exception
      '이 파일은 로컬 검증 전용입니다. 운영 데이터베이스에서 실행할 수 없습니다.';
  end if;
end;
$guard$;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$roles$;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase 는 신규 함수마다 이 세 역할에 EXECUTE 를 자동 부여한다.
-- 이 기본 권한을 재현해야 schema.sql 의 REVOKE 가 실제로 필요한지 검증할 수 있다.
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

-- Supabase 는 **표·뷰·시퀀스에도** 기본 권한을 준다. 접근 제어는 권한이 아니라
-- RLS 가 한다는 전제이기 때문이다. 이것을 재현하지 않으면
-- "권한이 없어서" 막힌 것을 "정책이 막았다"고 착각하게 된다 — 반대도 마찬가지다.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);

create or replace function auth.uid()
returns uuid language sql stable set search_path = auth, public as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$fn$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
