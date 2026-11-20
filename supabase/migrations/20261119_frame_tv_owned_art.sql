-- House → FrameTV: a manual "I have this" mark per artwork, so the family can
-- track which pieces are already in their TV's collection (separate from the
-- automatic frame_tv_sent_art history, which only covers sends from this app).
create table public.frame_tv_owned_art (
  id bigint generated always as identity primary key,
  family_id uuid not null default public.default_family_id() references public.families(id) on delete cascade,
  art_key text not null,       -- e.g. "met:123", same keys as frame_tv_sent_art
  title text,
  artist text,
  source text,
  thumb_url text,
  image_url text,
  source_url text,
  created_by text default public.current_email(),
  created_at timestamptz not null default now(),
  unique (family_id, art_key)
);

alter table public.frame_tv_owned_art enable row level security;

create policy "Family read access" on public.frame_tv_owned_art for select to authenticated using (family_id in (select public.my_family_ids()));
create policy "Family insert access" on public.frame_tv_owned_art for insert to authenticated with check (family_id in (select public.my_family_ids()));
create policy "Family update access" on public.frame_tv_owned_art for update to authenticated using (family_id in (select public.my_family_ids())) with check (family_id in (select public.my_family_ids()));
create policy "Family delete access" on public.frame_tv_owned_art for delete to authenticated using (family_id in (select public.my_family_ids()));
revoke all on public.frame_tv_owned_art from anon;
grant select, insert, update, delete on public.frame_tv_owned_art to authenticated;
