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
-- * Datensparsam: Sichtungen werden nach 3 Tagen gelöscht, Events 2 Tage nach dem Renntag
--   (ohne Renntag 7 Tage nach der letzten Änderung) – siehe Abschnitt „Ablauf“ unten.

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
  -- Abgelaufenes Event: keine Sichtungen mehr
  if exists (select 1 from supbuddy_private.events e where e.id = p_event and e.expires_at <= now()) then
    raise exception 'Abgelaufen' using errcode = 'PT410';
  end if;
  -- Aufräumen: Sichtungen älter als 3 Tage
  delete from supbuddy_private.sightings s where s.created_at < now() - interval '3 days';

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

-- ============================================================================
-- Stufe 5b: ganzes Event live (Strecke, Athleten, Renntag) für alle mit dem Link
-- ============================================================================
-- Gespeichert wird das Event im selben kompakten Format wie im Teilen-Link
-- (komprimiert, Base64url). Darin stehen Streckenpunkte, Athleten-Namen, Startzeiten,
-- Pace und Renntag. Wer den Link hat, darf lesen und ändern (wie ein geteiltes Dokument).
-- Gleichzeitige Änderungen: jede Änderung nennt die Version, auf der sie beruht; passt sie
-- nicht mehr, lehnt der Server ab und die App führt beide Stände zusammen.
-- Ablauf: siehe unten (2 Tage nach dem Renntag bzw. 7 Tage nach der letzten Änderung).

create table if not exists supbuddy_private.events (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{8,40}$'),
  data text not null check (char_length(data) <= 300000 and data ~ '^[A-Za-z0-9_-]+$'),
  version integer not null default 1,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists events_age_idx on supbuddy_private.events (updated_at);
alter table supbuddy_private.events enable row level security;
revoke all on supbuddy_private.events from public, anon, authenticated;

create table if not exists supbuddy_private.event_writes (
  user_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists event_writes_idx on supbuddy_private.event_writes (user_id, at desc);
alter table supbuddy_private.event_writes enable row level security;
revoke all on supbuddy_private.event_writes from public, anon, authenticated;

-- ---------------------------------------------------------------- Ablauf (datensparsam)
-- expires_at: Ende des Renntags + 2 Tage; ohne Renntag 7 Tage nach der letzten Änderung.
-- Danach werden die Daten gelöscht. Übrig bleibt nur ein Merkzettel „abgelaufen“
-- (Kennung + Zeitpunkt, ohne Inhalt), damit ein alter Link das Event nicht neu anlegt;
-- auch der verschwindet nach 60 Tagen.
alter table supbuddy_private.events add column if not exists expires_at timestamptz not null default (now() + interval '7 days');
alter table supbuddy_private.events alter column data drop not null;

create or replace function supbuddy_private.expiry(p_race_date date)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when p_race_date is not null and p_race_date between (current_date - 365) and (current_date + 365)
      then ((p_race_date + 3)::timestamp at time zone 'Europe/Berlin')
    else now() + interval '7 days'
  end;
$$;

create or replace function supbuddy_private.cleanup()
returns void
language sql
set search_path = ''
as $$
  update supbuddy_private.events e set data = null where e.expires_at <= now() and e.data is not null;
  delete from supbuddy_private.events e where e.expires_at < now() - interval '60 days';
  delete from supbuddy_private.sightings s where s.created_at < now() - interval '3 days'
    or s.event_id in (select e.id from supbuddy_private.events e where e.expires_at <= now());
  delete from supbuddy_private.event_writes w where w.at < now() - interval '1 day';
$$;
revoke all on function supbuddy_private.expiry(date) from public, anon, authenticated;
revoke all on function supbuddy_private.cleanup() from public, anon, authenticated;

-- Event lesen (nur mit Kennung). expired = abgelaufen (dann ohne Daten).
drop function if exists public.get_event(text);
create function public.get_event(p_event text)
returns table (data text, version integer, expires_at timestamptz, expired boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select case when e.expires_at > now() then e.data end, e.version, e.expires_at, e.expires_at <= now()
  from supbuddy_private.events e
  where auth.uid() is not null
    and p_event ~ '^[A-Za-z0-9_-]{8,40}$'
    and e.id = p_event;
$$;

-- Event anlegen oder ändern. p_base_version = Version, auf der die Änderung beruht (0 = neu).
-- p_race_date = Renntag (bestimmt, wann das Event abläuft).
-- Gibt die neue Version zurück; passt die Basis nicht → „Konflikt“ (409), abgelaufen → „Abgelaufen“ (410).
drop function if exists public.put_event(text, text, integer);
drop function if exists public.put_event(text, text, integer, date);
create function public.put_event(p_event text, p_data text, p_base_version integer, p_race_date date default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
  n integer;
  cur integer;
  exp timestamptz;
begin
  if uid is null then
    raise exception 'Anmeldung fehlt' using errcode = '42501';
  end if;
  if p_event !~ '^[A-Za-z0-9_-]{8,40}$' then
    raise exception 'Ungültige Kennung' using errcode = '22023';
  end if;
  if p_data is null or char_length(p_data) > 300000 or p_data !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'Ungültige Daten' using errcode = '22023';
  end if;
  -- Missbrauch begrenzen: pro Gerät 120 Änderungen in 10 Minuten
  select count(*) into n from supbuddy_private.event_writes w
    where w.user_id = uid and w.at > now() - interval '10 minutes';
  if n >= 120 then
    raise exception 'Zu viele Änderungen in kurzer Zeit' using errcode = '54000';
  end if;
  insert into supbuddy_private.event_writes (user_id) values (uid);
  perform supbuddy_private.cleanup();

  select e.version, e.expires_at into cur, exp from supbuddy_private.events e where e.id = p_event for update;
  if cur is null then
    insert into supbuddy_private.events (id, data, version, updated_by, expires_at)
      values (p_event, p_data, 1, uid, supbuddy_private.expiry(p_race_date));
    return 1;
  end if;
  if exp <= now() then
    -- Eigener Fehlercode → HTTP 410 („nicht mehr da“)
    raise exception 'Abgelaufen' using errcode = 'PT410';
  end if;
  if cur <> coalesce(p_base_version, -1) then
    -- Eigener Fehlercode → HTTP 409. (Nicht 40001: den wiederholt die Daten-API endlos.)
    raise exception 'Konflikt' using errcode = 'PT409';
  end if;
  update supbuddy_private.events e
    set data = p_data, version = cur + 1, updated_by = uid, updated_at = now(),
        expires_at = supbuddy_private.expiry(p_race_date)
    where e.id = p_event;
  return cur + 1;
end;
$$;

-- Sichtungen eines abgelaufenen Events nicht mehr herausgeben
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
    and not exists (select 1 from supbuddy_private.events e where e.id = p_event and e.expires_at <= now())
  order by s.seen_at desc
  limit 300;
$$;

-- Bestehende Events: Ablauf aus heutiger Sicht (7 Tage); beim nächsten Speichern zählt der Renntag
update supbuddy_private.events set expires_at = now() + interval '7 days' where expires_at > now() + interval '7 days';

revoke execute on function public.get_event(text) from public, anon, authenticated;
revoke execute on function public.put_event(text, text, integer, date) from public, anon, authenticated;
revoke execute on function public.get_sightings(text) from public, anon, authenticated;
grant execute on function public.get_event(text) to authenticated;
grant execute on function public.put_event(text, text, integer, date) to authenticated;
grant execute on function public.get_sightings(text) to authenticated;
