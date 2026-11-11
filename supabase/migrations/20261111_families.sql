-- Families: shared Paper + House, everything else personal per signed-in email.
-- Admin (app owner) is the only one who can create families / invite members.

create table public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.family_members (
  family_id uuid not null references public.families(id) on delete cascade,
  email text not null check (email = lower(email)),
  display_name text,
  role text not null default 'member' check (role in ('admin','member')),
  status text not null default 'invited' check (status in ('invited','active')),
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  primary key (family_id, email)
);

-- ---------- helpers ----------
create or replace function public.current_email() returns text
language sql stable set search_path = '' as
$$ select lower(auth.jwt() ->> 'email') $$;

create or replace function public.is_app_admin() returns boolean
language sql stable set search_path = '' as
$$ select coalesce(public.current_email() = 'jthorp@gmail.com', false) $$;

create or replace function public.my_family_ids() returns setof uuid
language sql stable security definer set search_path = '' as
$$ select family_id from public.family_members
   where email = public.current_email() and status = 'active' $$;

-- Family used when a shared row is inserted without one: the caller's first family,
-- or (for server-side inserts with no JWT) the oldest family.
create or replace function public.default_family_id() returns uuid
language sql stable security definer set search_path = '' as
$$ select coalesce(
     (select m.family_id from public.family_members m join public.families f on f.id = m.family_id
       where m.email = public.current_email() and m.status = 'active' order by f.created_at limit 1),
     (select id from public.families order by created_at limit 1)) $$;

-- Called right after sign-in: activates any pending invite for this email and
-- reports whether the user may use the app.
create or replace function public.my_access() returns jsonb
language plpgsql volatile security definer set search_path = '' as
$$
declare me text := public.current_email();
begin
  if me is null then return jsonb_build_object('allowed', false); end if;
  update public.family_members set status = 'active', joined_at = now()
   where email = me and status = 'invited';
  return jsonb_build_object(
    'email', me,
    'is_admin', public.is_app_admin(),
    'allowed', public.is_app_admin() or exists (select 1 from public.family_members where email = me),
    'families', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'role', m.role) order by f.created_at)
                          from public.family_members m join public.families f on f.id = m.family_id
                          where m.email = me), '[]'::jsonb));
end $$;

revoke execute on function public.my_access() from anon, public;
grant execute on function public.my_access() to authenticated;

alter table public.families enable row level security;
alter table public.family_members enable row level security;

create policy families_select on public.families for select to authenticated
  using (public.is_app_admin() or id in (select public.my_family_ids()));
create policy families_insert on public.families for insert to authenticated with check (public.is_app_admin());
create policy families_update on public.families for update to authenticated using (public.is_app_admin()) with check (public.is_app_admin());
create policy families_delete on public.families for delete to authenticated using (public.is_app_admin());

create policy family_members_select on public.family_members for select to authenticated
  using (public.is_app_admin() or family_id in (select public.my_family_ids()));
create policy family_members_insert on public.family_members for insert to authenticated with check (public.is_app_admin());
create policy family_members_update on public.family_members for update to authenticated using (public.is_app_admin()) with check (public.is_app_admin());
create policy family_members_delete on public.family_members for delete to authenticated using (public.is_app_admin());

-- Seed the first family with the admin as an active member.
with f as (insert into public.families (name) values ('Thorp Family') returning id)
insert into public.family_members (family_id, email, display_name, role, status, joined_at)
select id, 'jthorp@gmail.com', 'Justin', 'admin', 'active', now() from f;

-- ---------- re-point existing policies ----------
-- Rewrites every policy on a table to the given predicate, keeping its command.
create or replace function pg_temp.repoint(tbl text, pred text) returns void language plpgsql as $$
declare p record;
begin
  for p in select polname, polcmd from pg_policy where polrelid = ('public.' || tbl)::regclass loop
    if p.polcmd = 'a' then
      execute format('alter policy %I on public.%I with check (%s)', p.polname, tbl, pred);
    elsif p.polcmd in ('r','d') then
      execute format('alter policy %I on public.%I using (%s)', p.polname, tbl, pred);
    else
      execute format('alter policy %I on public.%I using (%s) with check (%s)', p.polname, tbl, pred, pred);
    end if;
  end loop;
end $$;

-- Personal tables: owner_email column, backfilled to the admin.
do $$
declare t text;
begin
  foreach t in array array['business_careers_checks','businesses','consumption_checkins','daily_log',
    'fasting_exclusions','food_plan','job_openings','people','person_notes','prayer_requests',
    'rule_of_life_disruptions','rule_of_life_log','rule_of_life_practices','user_settings'] loop
    execute format('alter table public.%I add column owner_email text', t);
    execute format('update public.%I set owner_email = %L', t, 'jthorp@gmail.com');
    -- No JWT (server-side imports) → admin, so existing ingestion keeps working.
    execute format('alter table public.%I alter column owner_email set default coalesce(public.current_email(), %L)', t, 'jthorp@gmail.com');
    execute format('alter table public.%I alter column owner_email set not null', t);
    execute format('create index on public.%I (owner_email)', t);
    perform pg_temp.repoint(t, 'owner_email = (select public.current_email())');
  end loop;
end $$;

-- Uniqueness becomes per-person.
alter table public.user_settings drop constraint user_settings_pkey, add primary key (owner_email, key);
alter table public.fasting_exclusions drop constraint fasting_exclusions_from_date_key, add unique (owner_email, from_date);
alter table public.consumption_checkins drop constraint consumption_checkins_log_date_key, add unique (owner_email, log_date);
alter table public.businesses drop constraint businesses_name_key, add unique (owner_email, name);
alter table public.rule_of_life_log drop constraint rule_of_life_log_practice_fkey;
alter table public.rule_of_life_practices drop constraint rule_of_life_practices_name_key, add unique (owner_email, name);
alter table public.rule_of_life_log add constraint rule_of_life_log_practice_fkey
  foreign key (owner_email, practice) references public.rule_of_life_practices(owner_email, name) on update cascade;

-- Shared (family) tables: Paper and House.
do $$
declare t text; fam uuid := (select id from public.families order by created_at limit 1);
begin
  foreach t in array array['paper_inventory','frame_tv_settings','frame_tv_sent_art'] loop
    execute format('alter table public.%I add column family_id uuid references public.families(id) on delete cascade', t);
    execute format('update public.%I set family_id = %L', t, fam);
    execute format('alter table public.%I alter column family_id set default public.default_family_id()', t);
    execute format('alter table public.%I alter column family_id set not null', t);
    execute format('create index on public.%I (family_id)', t);
    perform pg_temp.repoint(t, 'family_id in (select public.my_family_ids())');
  end loop;
end $$;

-- (applied as families_function_grants)
revoke execute on function public.my_family_ids(), public.default_family_id(), public.my_access() from public, anon;
grant execute on function public.my_family_ids(), public.default_family_id(), public.my_access() to authenticated, service_role;

-- ---------- (applied as families_security_hardening) ----------
-- Only trust an email Google vouched for. app_metadata isn't user-editable (user_metadata is).
create or replace function public.current_email() returns text
language sql stable set search_path = '' as
$$ select case when auth.jwt() -> 'app_metadata' ->> 'provider' = 'google'
               then lower(auth.jwt() ->> 'email') end $$;

-- Signed-out (anon) role gets no access to anything, now or for future tables.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

-- Auth hook: enable in Dashboard → Authentication → Hooks → "Before User Created".
create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as
$$
declare e text := lower(event -> 'user' ->> 'email');
begin
  if e = 'jthorp@gmail.com' or exists (select 1 from public.family_members where email = e) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'This app is invite-only. Ask for an invite first.'));
end $$;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
grant select on public.family_members to supabase_auth_admin;
