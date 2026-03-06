-- Flat view of all translate-list items for easy querying and export.
-- Arrays (possible_translations, examples_origin, examples_destination) are kept
-- as JSONB so you can use jsonb_array_elements_text() to unnest them if needed,
-- or just copy the result as JSON/CSV from the Supabase SQL editor.

create or replace view v_translations as
select
  i.id,
  i.created_at,
  i.updated_at,
  i.extra_fields->>'originExpression'                        as origin_expression,
  i.extra_fields->>'originLanguage'                          as origin_language,
  i.extra_fields->>'destinationLanguage'                     as destination_language,
  i.extra_fields->'possibleTranslations'                     as possible_translations,
  i.extra_fields->'examplesOrigin'                           as examples_origin,
  i.extra_fields->'examplesDestination'                      as examples_destination,
  i.extra_fields->>'comments'                                as comments,
  i.priority,
  i.status,
  i.archived_at
from pa_list_items i
where i.list_id = 'translate'
order by i.created_at desc;




-- SELECT examples of how to query the view:

-- -- All active translations
--   select * from v_translations where archived_at is null;

--   -- Unnest possible_translations into one row per translation
--   select
--     origin_expression,
--     origin_language,
--     destination_language,
--     t.value as translation
--   from v_translations,
--     jsonb_array_elements_text(possible_translations) as t(value)
--   where archived_at is null;

--   -- Full CSV export (run in psql)
--   \copy (select * from v_translations) to 'translations.csv' csv header
