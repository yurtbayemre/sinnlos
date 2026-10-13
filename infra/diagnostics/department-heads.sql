-- Department heads drift report (READ-ONLY).
--
-- From batch 15 on, a user is a department author of department D when the
-- user's role type is department_head AND user.department is D, read per
-- request (decision 06 §N1, question 14's default). The department's `head`
-- relation stays display-only: no gate reads it. Every department_head with
-- a department can author announcements and events for it after the deploy.
-- This report shows, per department, the `head` and the department_head
-- users who belong to it, and the mismatches the owner aligns in the admin
-- panel before department heads start authoring:
--   - head_without_role: the department's head is not a department_head
--     (the head cannot author; set the role if they should);
--   - head_of_other_department: the head's own user.department is another
--     department, or none (the head authors for that one, or for none);
--   - department_head_without_department: a department_head user without a
--     department authors nothing (fail closed);
--   - department_without_head_role: a department no department_head
--     belongs to (nobody authors for it but moderators).
--
-- Runs on the batch-14 schema (before the deploy) and on every later one.
--
--   docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/diagnostics/department-heads.sql
--
-- The output names users (id, username, display name, blocked), no e-mail
-- addresses or other contact data; it is internal operational data, do not
-- post it publicly.
--
-- Pure SQL, no psql meta-commands: the integration suite
-- targeting-fail-closed runs this file against Postgres 16 as it is.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- Per department: the head (display-only relation) and the department_head
-- users whose user.department is it.
SELECT 'department' AS check,
       d.id AS department_id,
       d.name AS department,
       hu.id AS head_user_id,
       hu.username AS head_username,
       hr.type AS head_role,
       (SELECT string_agg(u.username || CASE WHEN u.blocked IS TRUE THEN ' (blocked)' ELSE '' END,
                          ', ' ORDER BY u.username)
          FROM up_users u
          JOIN up_users_department_lnk ud ON ud.user_id = u.id AND ud.department_id = d.id
          JOIN up_users_role_lnk ur ON ur.user_id = u.id
          JOIN up_roles r ON r.id = ur.role_id AND r.type = 'department_head') AS department_heads
  FROM departments d
  LEFT JOIN departments_head_lnk h ON h.department_id = d.id
  LEFT JOIN up_users hu ON hu.id = h.user_id
  LEFT JOIN up_users_role_lnk hur ON hur.user_id = hu.id
  LEFT JOIN up_roles hr ON hr.id = hur.role_id
 ORDER BY d.name, d.id;

-- The mismatches, one row each.
SELECT 'mismatch' AS check, kind, department_id, department, user_id, username, display_name,
       blocked, detail
  FROM (
    -- The head is not a department_head.
    SELECT 'head_without_role' AS kind, d.id AS department_id, d.name AS department,
           u.id AS user_id, u.username, u.display_name, u.blocked,
           coalesce(r.type, '(no role)') AS detail
      FROM departments d
      JOIN departments_head_lnk h ON h.department_id = d.id
      JOIN up_users u ON u.id = h.user_id
      LEFT JOIN up_users_role_lnk ur ON ur.user_id = u.id
      LEFT JOIN up_roles r ON r.id = ur.role_id
     WHERE r.type IS DISTINCT FROM 'department_head'
    UNION ALL
    -- The head belongs to another department, or to none.
    SELECT 'head_of_other_department', d.id, d.name, u.id, u.username, u.display_name, u.blocked,
           coalesce('member of ' || od.name, '(no department)')
      FROM departments d
      JOIN departments_head_lnk h ON h.department_id = d.id
      JOIN up_users u ON u.id = h.user_id
      LEFT JOIN up_users_department_lnk ud ON ud.user_id = u.id
      LEFT JOIN departments od ON od.id = ud.department_id
     WHERE ud.department_id IS DISTINCT FROM d.id
    UNION ALL
    -- A department_head without a department.
    SELECT 'department_head_without_department', NULL, NULL, u.id, u.username, u.display_name,
           u.blocked, NULL
      FROM up_users u
      JOIN up_users_role_lnk ur ON ur.user_id = u.id
      JOIN up_roles r ON r.id = ur.role_id AND r.type = 'department_head'
     WHERE NOT EXISTS (SELECT 1 FROM up_users_department_lnk ud WHERE ud.user_id = u.id)
    UNION ALL
    -- A department no department_head belongs to.
    SELECT 'department_without_head_role', d.id, d.name, NULL, NULL, NULL, NULL, NULL
      FROM departments d
     WHERE NOT EXISTS (
       SELECT 1
         FROM up_users_department_lnk ud
         JOIN up_users_role_lnk ur ON ur.user_id = ud.user_id
         JOIN up_roles r ON r.id = ur.role_id AND r.type = 'department_head'
        WHERE ud.department_id = d.id)
  ) mismatches
 ORDER BY kind, department, username;

ROLLBACK;
