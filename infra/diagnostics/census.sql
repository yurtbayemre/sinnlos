-- Sinnlos production data census (READ-ONLY).
-- Table and column names follow Strapi 5.49's naming for the repo's schema.json
-- files. Draft&Publish types keep a
-- draft row AND a published row per document, so documents are counted with
-- count(DISTINCT document_id); link-table rows are split by published_at.
-- Run on the host: infra/diagnostics/census.sh (or pipe this file into psql as shown there).
\pset pager off
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

\echo '== 0. schema presence (a missing row = attribute never booted on this DB)'
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema = current_schema()
   AND (table_name, column_name) IN (
     ('announcements','expires_at'), ('lessons','quiz'), ('courses','completion_mode'),
     ('up_users','provider'), ('up_users','digest_announcements'), ('up_users','digest_mentions'),
     ('up_users','digest_kudos'), ('up_users','digest_frequency'), ('up_users','last_digest_at'),
     ('notifications','source_document_id'), ('notifications','title'),
     ('comments','target_id'), ('comments','target_document_id'))
 ORDER BY 1, 2;
SELECT table_name FROM information_schema.tables
 WHERE table_schema = current_schema()
   AND table_name IN ('comments_parent_lnk','polls_departments_lnk','events_departments_lnk',
     'wiki_pages_department_lnk','wiki_pages_team_lnk','wiki_revisions_editor_lnk',
     'wiki_revisions_page_lnk','notifications_recipient_lnk','notifications_actor_lnk')
 ORDER BY 1;

\echo '== 1. comment threading (comments.parent)'
SELECT count(*)                                              AS comments_total,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM comments_parent_lnk p WHERE p.comment_id = c.id))
                                                             AS comments_with_parent,
       count(*) FILTER (WHERE c.target_document_id IS NULL)  AS comments_without_target_document_id,
       count(*) FILTER (WHERE c.body LIKE '[live-smoke]%')   AS live_smoke_leftovers
  FROM comments c;
SELECT count(*) AS parent_link_rows,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM comments x WHERE x.id = l.inv_comment_id)) AS dangling_parent_links
  FROM comments_parent_lnk l;

\echo '== 2. announcements.expires_at'
SELECT count(DISTINCT document_id)                                         AS announcement_docs,
       count(DISTINCT document_id) FILTER (WHERE expires_at IS NOT NULL)   AS docs_with_expires_at,
       count(*) FILTER (WHERE expires_at IS NOT NULL AND published_at IS NOT NULL) AS published_rows_with_expires_at,
       count(*) FILTER (WHERE expires_at < now() AND published_at IS NOT NULL)     AS published_rows_already_expired,
       min(expires_at) AS min_expires_at, max(expires_at) AS max_expires_at
  FROM announcements;

\echo '== 3. poll / event department targeting'
SELECT 'polls' AS type,
       (SELECT count(DISTINCT document_id) FROM polls)  AS docs_total,
       count(DISTINCT p.document_id)                     AS docs_with_departments,
       count(DISTINCT p.document_id) FILTER (WHERE p.published_at IS NOT NULL) AS published_docs_with_departments,
       count(*)                                          AS link_rows
  FROM polls_departments_lnk l JOIN polls p ON p.id = l.poll_id
UNION ALL
SELECT 'events',
       (SELECT count(DISTINCT document_id) FROM events),
       count(DISTINCT e.document_id),
       count(DISTINCT e.document_id) FILTER (WHERE e.published_at IS NOT NULL),
       count(*)
  FROM events_departments_lnk l JOIN events e ON e.id = l.event_id;

\echo '== 4. wiki pages with page-level department / team'
SELECT count(DISTINCT w.document_id) AS wiki_page_docs,
       count(DISTINCT w.document_id) FILTER (WHERE EXISTS (SELECT 1 FROM wiki_pages_department_lnk d WHERE d.wiki_page_id = w.id)) AS docs_with_department,
       count(DISTINCT w.document_id) FILTER (WHERE EXISTS (SELECT 1 FROM wiki_pages_team_lnk t WHERE t.wiki_page_id = w.id))       AS docs_with_team,
       count(DISTINCT w.document_id) FILTER (WHERE EXISTS (SELECT 1 FROM wiki_pages_last_editor_lnk le WHERE le.wiki_page_id = w.id)) AS docs_with_last_editor
  FROM wiki_pages w;

\echo '== 5. wiki revisions: editor set (REST controller or lastEditor fallback) vs null; summary set = REST only'
SELECT count(*)                                                       AS revisions_total,
       count(*) FILTER (WHERE e.wiki_revision_id IS NOT NULL)         AS with_editor,
       count(*) FILTER (WHERE e.wiki_revision_id IS NULL)             AS without_editor,
       count(*) FILTER (WHERE coalesce(r.summary, '') <> '')          AS with_summary_rest_only,
       min(r.created_at) AS first_revision, max(r.created_at) AS last_revision
  FROM wiki_revisions r
  LEFT JOIN wiki_revisions_editor_lnk e ON e.wiki_revision_id = r.id;
SELECT CASE WHEN w.id IS NULL THEN 'page row gone'
            WHEN w.published_at IS NULL THEN 'points at DRAFT page row'
            ELSE 'points at PUBLISHED page row' END AS revision_page_link,
       count(*)
  FROM wiki_revisions r
  LEFT JOIN wiki_revisions_page_lnk pl ON pl.wiki_revision_id = r.id
  LEFT JOIN wiki_pages w ON w.id = pl.wiki_page_id
 GROUP BY 1 ORDER BY 1;

\echo '== 6. training: lessons.quiz shape, courses.completion_mode'
SELECT coalesce(jsonb_typeof(quiz), 'SQL NULL') AS quiz_json_type,
       count(DISTINCT document_id) AS lesson_docs,
       count(*) FILTER (WHERE published_at IS NOT NULL) AS published_rows,
       count(*) FILTER (WHERE CASE WHEN jsonb_typeof(quiz) = 'array' THEN jsonb_array_length(quiz) > 0 ELSE false END) AS rows_nonempty_array
  FROM lessons GROUP BY 1 ORDER BY 1;
SELECT completion_mode, count(DISTINCT document_id) AS course_docs FROM courses GROUP BY 1 ORDER BY 1;

\echo '== 7. users: provider, demo accounts, digest opt-in'
SELECT coalesce(provider, '(null)') AS provider, count(*) AS users,
       count(*) FILTER (WHERE blocked IS TRUE) AS blocked,
       count(microsoft_oid) AS with_microsoft_oid,
       count(*) FILTER (WHERE email LIKE '%@sinnlos.local') AS demo_seed_accounts
  FROM up_users GROUP BY 1 ORDER BY 1;
SELECT count(*) FILTER (WHERE digest_announcements IS TRUE) AS opt_announcements,
       count(*) FILTER (WHERE digest_mentions IS TRUE)      AS opt_mentions,
       count(*) FILTER (WHERE digest_kudos IS TRUE)         AS opt_kudos,
       count(*) FILTER (WHERE (digest_announcements OR digest_mentions OR digest_kudos) IS TRUE AND blocked IS NOT TRUE) AS digest_candidates,
       count(*) FILTER (WHERE digest_frequency = 'daily')   AS freq_daily,
       count(last_digest_at)                                AS ever_received_digest,
       max(last_digest_at)                                  AS last_digest_sent
  FROM up_users;

\echo '== 8. notifications: volume, age, title length, anchors, recipients'
SELECT count(*) AS notifications_total, min(created_at) AS oldest, max(created_at) AS newest,
       max(length(title)) AS max_title_len,
       count(*) FILTER (WHERE length(title) >= 240) AS titles_ge_240,
       count(*) FILTER (WHERE read_at IS NULL) AS unread,
       count(*) FILTER (WHERE type IN ('announcement','event') AND source_document_id IS NULL) AS unanchored_fanout_rows,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM notifications_recipient_lnk r WHERE r.notification_id = n.id)) AS without_recipient
  FROM notifications n;
SELECT type, count(*), min(created_at) AS oldest, max(length(title)) AS max_title_len
  FROM notifications GROUP BY 1 ORDER BY 1;
SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, count(*)
  FROM notifications GROUP BY 1 ORDER BY 1;
\echo '-- comment notifications whose actor is the live-smoke author (deploy residue; live-smoke deletes the comments, not these)'
SELECT count(*) AS smoke_author_comment_notifications
  FROM notifications n
  JOIN notifications_actor_lnk a ON a.notification_id = n.id
  JOIN up_users u ON u.id = a.user_id
 WHERE n.type = 'comment' AND u.email = 'sam.chen@sinnlos.local';
\echo '-- sources whose fan-out title would overflow varchar(255) ("New announcement: " = 18, "New event: " = 11 chars)'
SELECT 'announcements' AS src, count(DISTINCT document_id) AS docs, max(length(title)) AS max_title_len
  FROM announcements WHERE length(title) > 255 - 18
UNION ALL
SELECT 'events', count(DISTINCT document_id), max(length(title)) FROM events WHERE length(title) > 255 - 11;

\echo '== 9. DA04 duplicate scan: interaction records that no unique index guards (counts only, no ids)'
\echo '-- The owning user sits in a link table, so no index can make these unique today; the writers'
\echo '-- check-then-insert and the readers dedupe. pairs = distinct keys, duplicate_keys = keys with'
\echo '-- more than one row, surplus_rows = rows beyond the first per key, max_rows = the largest group.'
\echo '-- Rows without the user link cannot collide and are counted apart (without_user).'
\echo '-- (poll, voter): one ballot per voter and poll row (utils/poll-ballots.ts counts the first)'
SELECT 'poll_votes (poll, voter)' AS scan,
       count(*)                                          AS pairs,
       count(*) FILTER (WHERE n > 1)                     AS duplicate_keys,
       coalesce(sum(n - 1) FILTER (WHERE n > 1), 0)      AS surplus_rows,
       coalesce(max(n), 0)                               AS max_rows
  FROM (SELECT pl.poll_id, vl.user_id, count(*) AS n
          FROM poll_votes v
          JOIN poll_votes_poll_lnk pl  ON pl.poll_vote_id = v.id
          JOIN poll_votes_voter_lnk vl ON vl.poll_vote_id = v.id
         GROUP BY pl.poll_id, vl.user_id) k;
SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM poll_votes_voter_lnk l WHERE l.poll_vote_id = v.id)) AS votes_without_user,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM poll_votes_poll_lnk l WHERE l.poll_vote_id = v.id))  AS votes_without_poll
  FROM poll_votes v;
\echo '-- (target, user) receipts: acknowledgements (targetType + targetDocumentId), RSVPs and lesson progress (targetDocumentId)'
SELECT 'acknowledgements (target, user)' AS scan,
       count(*) AS pairs, count(*) FILTER (WHERE n > 1) AS duplicate_keys,
       coalesce(sum(n - 1) FILTER (WHERE n > 1), 0) AS surplus_rows, coalesce(max(n), 0) AS max_rows,
       (SELECT count(*) FROM acknowledgements a
         WHERE NOT EXISTS (SELECT 1 FROM acknowledgements_user_lnk l WHERE l.acknowledgement_id = a.id)) AS without_user
  FROM (SELECT a.target_type, a.target_document_id, l.user_id, count(*) AS n
          FROM acknowledgements a JOIN acknowledgements_user_lnk l ON l.acknowledgement_id = a.id
         GROUP BY a.target_type, a.target_document_id, l.user_id) k
UNION ALL
SELECT 'event_rsvps (target, user)',
       count(*), count(*) FILTER (WHERE n > 1),
       coalesce(sum(n - 1) FILTER (WHERE n > 1), 0), coalesce(max(n), 0),
       (SELECT count(*) FROM event_rsvps e
         WHERE NOT EXISTS (SELECT 1 FROM event_rsvps_user_lnk l WHERE l.event_rsvp_id = e.id))
  FROM (SELECT e.target_document_id, l.user_id, count(*) AS n
          FROM event_rsvps e JOIN event_rsvps_user_lnk l ON l.event_rsvp_id = e.id
         GROUP BY e.target_document_id, l.user_id) k
UNION ALL
SELECT 'lesson_progresses (target, user)',
       count(*), count(*) FILTER (WHERE n > 1),
       coalesce(sum(n - 1) FILTER (WHERE n > 1), 0), coalesce(max(n), 0),
       (SELECT count(*) FROM lesson_progresses p
         WHERE NOT EXISTS (SELECT 1 FROM lesson_progresses_user_lnk l WHERE l.lesson_progress_id = p.id))
  FROM (SELECT p.target_document_id, l.user_id, count(*) AS n
          FROM lesson_progresses p JOIN lesson_progresses_user_lnk l ON l.lesson_progress_id = p.id
         GROUP BY p.target_document_id, l.user_id) k;
\echo '-- (target, emoji, author) reactions: the controller keeps the oldest row after each create'
SELECT 'reactions (target, emoji, author)' AS scan,
       count(*) AS pairs, count(*) FILTER (WHERE n > 1) AS duplicate_keys,
       coalesce(sum(n - 1) FILTER (WHERE n > 1), 0) AS surplus_rows, coalesce(max(n), 0) AS max_rows,
       (SELECT count(*) FROM reactions r
         WHERE NOT EXISTS (SELECT 1 FROM reactions_author_lnk l WHERE l.reaction_id = r.id)) AS without_user,
       (SELECT count(*) FROM reactions WHERE target_document_id IS NULL) AS without_target_document_id
  FROM (SELECT r.target_type, r.target_document_id, r.emoji, l.user_id, count(*) AS n
          FROM reactions r JOIN reactions_author_lnk l ON l.reaction_id = r.id
         GROUP BY r.target_type, r.target_document_id, r.emoji, l.user_id) k;
\echo '-- per month of the newest row of each duplicate group (does the race still happen?)'
SELECT scan, to_char(date_trunc('month', newest), 'YYYY-MM') AS month, count(*) AS duplicate_keys
  FROM (SELECT 'poll_votes' AS scan, max(v.created_at) AS newest
          FROM poll_votes v
          JOIN poll_votes_poll_lnk pl  ON pl.poll_vote_id = v.id
          JOIN poll_votes_voter_lnk vl ON vl.poll_vote_id = v.id
         GROUP BY pl.poll_id, vl.user_id HAVING count(*) > 1
        UNION ALL
        SELECT 'acknowledgements', max(a.created_at)
          FROM acknowledgements a JOIN acknowledgements_user_lnk l ON l.acknowledgement_id = a.id
         GROUP BY a.target_type, a.target_document_id, l.user_id HAVING count(*) > 1
        UNION ALL
        SELECT 'event_rsvps', max(e.created_at)
          FROM event_rsvps e JOIN event_rsvps_user_lnk l ON l.event_rsvp_id = e.id
         GROUP BY e.target_document_id, l.user_id HAVING count(*) > 1
        UNION ALL
        SELECT 'lesson_progresses', max(p.created_at)
          FROM lesson_progresses p JOIN lesson_progresses_user_lnk l ON l.lesson_progress_id = p.id
         GROUP BY p.target_document_id, l.user_id HAVING count(*) > 1
        UNION ALL
        SELECT 'reactions', max(r.created_at)
          FROM reactions r JOIN reactions_author_lnk l ON l.reaction_id = r.id
         GROUP BY r.target_type, r.target_document_id, r.emoji, l.user_id HAVING count(*) > 1) d
 GROUP BY 1, 2 ORDER BY 1, 2;

ROLLBACK;
