/**
 * The owner's legacy database in miniature, for the *.pg.test.ts suites of
 * the one-time datetime repair and its report. The cms wrote UTC wall clocks
 * until the TZ switch on 2026-08-15 (last write 18:40 UTC) and Berlin wall
 * clocks after it (first write at 18:50 UTC, stored as 20:50); the tables
 * mirror the Strapi shapes (naive timestamp(6), date columns, bookkeeping).
 * Run FIXTURE_TABLES and FIXTURE_ROWS with search_path set to the test schema.
 */
export const FIXTURE_TABLES = `
  CREATE TABLE events (id serial PRIMARY KEY, document_id varchar(255), title varchar(255),
    start timestamp(6), "end" timestamp(6), all_day boolean,
    created_at timestamp(6), updated_at timestamp(6), published_at timestamp(6));
  CREATE TABLE polls (id serial PRIMARY KEY, document_id varchar(255), question varchar(255),
    closes_at timestamp(6), created_at timestamp(6), updated_at timestamp(6), published_at timestamp(6));
  CREATE TABLE announcements (id serial PRIMARY KEY, document_id varchar(255), title varchar(255),
    expires_at timestamp(6), ack_deadline date,
    created_at timestamp(6), updated_at timestamp(6), published_at timestamp(6));
  CREATE TABLE search_logs (id serial PRIMARY KEY, term varchar(255), result_count integer,
    created_at timestamp(6), updated_at timestamp(6));
  CREATE TABLE strapi_sessions (id serial PRIMARY KEY, session_id varchar(255),
    expires_at timestamp(6), absolute_expires_at timestamp(6),
    created_at timestamp(6), updated_at timestamp(6));
  CREATE TABLE up_users (id serial PRIMARY KEY, username varchar(255), birthday date, hire_date date,
    last_digest_at timestamp(6), created_at timestamp(6), updated_at timestamp(6));
  CREATE TABLE strapi_migrations (id serial PRIMARY KEY, name varchar(255), time timestamp);
  CREATE TABLE strapi_database_schema (id serial PRIMARY KEY, schema json, time timestamp, hash varchar(255));
`;

export const FIXTURE_ROWS = `
  -- E1: untouched since before the switch (class B).
  INSERT INTO events (document_id, title, start, "end", all_day, created_at, updated_at, published_at) VALUES
    ('e1', 'Summer party', '2026-06-20 16:00', NULL, false, '2026-06-01 10:00', '2026-06-01 10:00', '2026-06-01 10:00');
  -- E2: draft + published twin, re-published after the switch without re-entering the time (class C).
  INSERT INTO events (document_id, title, start, "end", all_day, created_at, updated_at, published_at) VALUES
    ('e2', 'Town hall', '2026-10-10 08:00', NULL, false, '2026-07-01 09:00', '2026-09-01 12:00', NULL),
    ('e2', 'Town hall', '2026-10-10 08:00', NULL, false, '2026-07-01 09:00', '2026-09-01 12:00', '2026-09-01 12:00');
  -- E3: created after the switch, a November (CET) event (class A).
  INSERT INTO events (document_id, title, start, "end", all_day, created_at, updated_at, published_at) VALUES
    ('e3', 'Winter fair', '2026-11-05 18:00', '2026-11-05 20:00', false, '2026-09-10 14:00', '2026-09-10 14:00', '2026-09-10 14:00');
  -- E4: all-day, time corrected to Berlin midnight after the switch (class C all-day exception).
  -- E5: all-day, never corrected: still the UTC value of Berlin midnight (class C).
  INSERT INTO events (document_id, title, start, "end", all_day, created_at, updated_at, published_at) VALUES
    ('e4', 'Offsite (corrected)', '2026-10-01 00:00', NULL, true, '2026-07-01 09:00', '2026-09-01 12:00', '2026-09-01 12:00'),
    ('e5', 'Offsite (kept)', '2026-09-30 22:00', NULL, true, '2026-07-01 09:00', '2026-09-01 12:00', '2026-09-01 12:00');
  INSERT INTO polls (document_id, question, closes_at, created_at, updated_at, published_at) VALUES
    ('p1', 'Lunch?', '2026-08-27 23:59:59', '2026-08-20 09:00', '2026-08-20 09:00', '2026-08-20 09:00');
  INSERT INTO announcements (document_id, title, expires_at, ack_deadline, created_at, updated_at, published_at) VALUES
    ('a1', 'Policy', '2026-12-01 00:00', '2026-10-01', '2026-06-01 10:00', '2026-06-01 10:00', '2026-06-01 10:00');
  INSERT INTO search_logs (term, result_count, created_at, updated_at) VALUES
    ('before', 1, '2026-07-01 09:00', '2026-07-01 09:00'),
    ('last before', 1, '2026-08-15 18:40', '2026-08-15 18:40'),
    ('first after', 0, '2026-08-15 20:50', '2026-08-15 20:50'),
    ('after', 0, '2026-09-01 12:00', '2026-09-01 12:00');
  INSERT INTO strapi_sessions (session_id, expires_at, absolute_expires_at, created_at, updated_at) VALUES
    ('new', '2026-09-17 14:00', '2026-10-10 14:00', '2026-09-10 14:00', '2026-09-10 14:00'),
    ('old', '2026-08-22 18:40', NULL, '2026-08-15 18:40', '2026-08-15 18:40');
  INSERT INTO up_users (username, birthday, hire_date, last_digest_at, created_at, updated_at) VALUES
    ('dana', '1990-10-01', '2016-04-01', '2026-09-14 07:30', '2026-06-01 10:00', '2026-09-14 07:30');
  INSERT INTO strapi_migrations (name, time) VALUES ('earlier.js', '2026-09-01 12:00');
  INSERT INTO strapi_database_schema (schema, time, hash) VALUES ('{}', '2026-09-01 12:00', 'h1');
`;
