-- SupBuddy – Datenbank für Sichtungen („Jan jetzt hier“)
-- Einmalig im Supabase SQL Editor ausführen (kann gefahrlos erneut ausgeführt werden).
--
-- Sicherheitsprinzip:
-- * Die Tabelle liegt in einem eigenen Schema, das die Daten-API NICHT veröffentlicht.
--   Niemand kann sie direkt lesen oder beschreiben – auch nicht mit dem öffentlichen Schlüssel.
-- * Zugriff nur über die Funktionen unten. Sie prüfen jede Eingabe, verlangen eine
--   (anonyme) Anmeldung, begrenzen die Menge und geben nur Sichtungen des Events heraus,
--   dessen nicht erratbare Kennung man kennt (steht nur im Teilen-Link).
-- * Gespeichert wird nichts Persönliches: keine Namen, keine Standorte von Personen –
--   nur Event-Kennung, Athleten-Kennung, Stelle auf der Strecke (Meter) und Uhrzeit.
-- * Alte Sichtungen werden nach 30 Tagen automatisch gelöscht.

create schema if not exists supbuddy_private;
revoke all on schema supbuddy_private from public, anon, authenticated;

create table if not exists supbuddy_private.sightings (
  id uuid primary key default gen_random_uuid(),
  event_id text not null check (event_id ~ '^[A-Za-z0-9_-]{8,40}$'),
  athlete_id text not null check (athlete_id ~ '^[A-Za-z0-9_-]{8,40}$'),
  along_m integer not null check (along_m between 0 and 1000000),
  seen_at timestamptz not null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists sightings_event_idx on supbuddy_private.sightings (event_id, seen_at desc);
create index if not exists sightings_user_idx on supbuddy_private.sightings (created_by, created_at desc);
create index if not exists sightings_age_idx on supbuddy_private.sightings (created_at);
alter table supbuddy_private.sightings enable row level security;
revoke all on supbuddy_private.sightings from public, anon, authenticated;

-- Sichtung eintragen
create or replace function public.add_sighting(p_event text, p_athlete text, p_along integer, p_seen timestamptz)
returns table (id uuid, athlete_id text, along_m integer, seen_at timestamptz, mine boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
  n integer;
  new_id uuid;
begin
  if uid is null then
    raise exception 'Anmeldung fehlt' using errcode = '42501';
  end if;
  if p_event !~ '^[A-Za-z0-9_-]{8,40}$' or p_athlete !~ '^[A-Za-z0-9_-]{8,40}$' then
    raise exception 'Ungültige Kennung' using errcode = '22023';
  end if;
  if p_along is null or p_along < 0 or p_along > 1000000 then
    raise exception 'Ungültige Stelle' using errcode = '22023';
  end if;
  if p_seen is null or p_seen > now() + interval '5 minutes' or p_seen < now() - interval '2 days' then
    raise exception 'Ungültige Uhrzeit' using errcode = '22023';
  end if;
  -- Missbrauch begrenzen: pro Gerät 30 Sichtungen in 10 Minuten, pro Event 1000 insgesamt
  select count(*) into n from supbuddy_private.sightings s
    where s.created_by = uid and s.created_at > now() - interval '10 minutes';
  if n >= 30 then
    raise exception 'Zu viele Sichtungen in kurzer Zeit' using errcode = '54000';
  end if;
  select count(*) into n from supbuddy_private.sightings s where s.event_id = p_event;
  if n >= 1000 then
    raise exception 'Event hat zu viele Sichtungen' using errcode = '54000';
  end if;
  -- Aufräumen: alles älter als 30 Tage
  delete from supbuddy_private.sightings s where s.created_at < now() - interval '30 days';

  insert into supbuddy_private.sightings (event_id, athlete_id, along_m, seen_at, created_by)
    values (p_event, p_athlete, p_along, p_seen, uid)
    returning supbuddy_private.sightings.id into new_id;
  return query
    select s.id, s.athlete_id, s.along_m, s.seen_at, true from supbuddy_private.sightings s where s.id = new_id;
end;
$$;

-- Sichtungen eines Events lesen (nur mit Kennung; ohne Angabe, wer sie eingetragen hat)
create or replace function public.get_sightings(p_event text)
returns table (id uuid, athlete_id text, along_m integer, seen_at timestamptz, mine boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.athlete_id, s.along_m, s.seen_at, s.created_by = auth.uid()
  from supbuddy_private.sightings s
  where auth.uid() is not null
    and p_event ~ '^[A-Za-z0-9_-]{8,40}$'
    and s.event_id = p_event
  order by s.seen_at desc
  limit 300;
$$;

-- Eigene Sichtung zurücknehmen (nur die selbst eingetragenen)
create or replace function public.delete_sighting(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from supbuddy_private.sightings s where s.id = p_id and s.created_by = auth.uid();
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- Lebenszeichen für den automatischen Weckruf (verhindert die Pause des Gratis-Projekts)
create or replace function public.ping()
returns text
language sql
stable
set search_path = ''
as $$ select 'ok'::text $$;

-- Rechte: Funktionen standardmäßig für niemanden, dann gezielt freigeben
revoke execute on function public.add_sighting(text, text, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.get_sightings(text) from public, anon, authenticated;
revoke execute on function public.delete_sighting(uuid) from public, anon, authenticated;
revoke execute on function public.ping() from public, anon, authenticated;
grant execute on function public.add_sighting(text, text, integer, timestamptz) to authenticated;
grant execute on function public.get_sightings(text) to authenticated;
grant execute on function public.delete_sighting(uuid) to authenticated;
grant execute on function public.ping() to anon, authenticated;
