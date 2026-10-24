-- infra/ops-check.sql (v0.29, S8): the cron status the cms keeps in its core
-- store (apps/cms/src/cron/cron-status.ts), for infra/ops-check.sh, which runs
-- it with psql in the db container and `-v schema=<the cms's DATABASE_SCHEMA>`.
-- One line per row, `|`-separated:
--   expected|<cronEnabled if boolean>|<jsonb type of tasks>|<task count>||||
--   task|<name>|<everyMinutes>|<firstExpectedAt>|<status row yes/no>|<lastFinishedAt>|<lastOutcome>|<lastFailedAt>
-- A value that is not JSON fails the cast, so psql fails and the check
-- reports UNKNOWN; every other shape is passed on for ops-check.sh to judge.
with rows as (
  select key, value::jsonb as v
    from :"schema".strapi_core_store_settings
   where key like 'plugin_sinnlos_cron:%' and type = 'object'
     and environment is null and tag is null
), expected as (
  select v from rows where key = 'plugin_sinnlos_cron:expected'
)
select 'expected' as kind,
       case jsonb_typeof(v -> 'cronEnabled') when 'boolean' then v ->> 'cronEnabled' else '' end as a,
       coalesce(jsonb_typeof(v -> 'tasks'), '') as b,
       case jsonb_typeof(v -> 'tasks') when 'array' then jsonb_array_length(v -> 'tasks')::text else '' end as c,
       '' as d, '' as e, '' as f, '' as g
  from expected
union all
select 'task',
       coalesce(t ->> 'name', ''),
       coalesce(t ->> 'everyMinutes', ''),
       coalesce(t ->> 'firstExpectedAt', ''),
       case when s.key is null then 'no' else 'yes' end,
       coalesce(s.v ->> 'lastFinishedAt', ''),
       coalesce(s.v ->> 'lastOutcome', ''),
       coalesce(s.v ->> 'lastFailedAt', '')
  from expected
 cross join lateral jsonb_array_elements(
         case jsonb_typeof(expected.v -> 'tasks') when 'array' then expected.v -> 'tasks' else '[]'::jsonb end
       ) as t
  left join rows s on s.key = 'plugin_sinnlos_cron:' || (t ->> 'name');
