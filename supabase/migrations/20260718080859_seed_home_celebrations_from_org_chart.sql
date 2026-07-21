with org_chart_celebrations (
  display_name,
  event_type,
  event_month,
  event_day,
  start_year
) as (
  values
    ('Arezval Loiej Angelo A. Santos', 'birthday', 3, 18, null::smallint),
    ('Arezval Loiej Angelo A. Santos', 'anniversary', 7, 13, 2022::smallint),
    ('Jerson V. Gavileño', 'birthday', 12, 29, null::smallint),
    ('Jerson V. Gavileño', 'anniversary', 11, 21, 2022::smallint),
    ('Alen Tristan Adeva', 'birthday', 8, 15, null::smallint),
    ('Alen Tristan Adeva', 'anniversary', 8, 5, 2024::smallint),
    ('Amora Angeles', 'birthday', 11, 19, null::smallint),
    ('Amora Angeles', 'anniversary', 7, 13, 2022::smallint),
    ('Leufard P. Vallega', 'birthday', 4, 6, null::smallint),
    ('Leufard P. Vallega', 'anniversary', 1, 30, 2023::smallint),
    ('Genevive Serrano', 'birthday', 8, 2, null::smallint),
    ('Genevive Serrano', 'anniversary', 2, 11, 2025::smallint),
    ('Jean-Michel Jarre Vestil', 'birthday', 7, 22, null::smallint),
    ('Jean-Michel Jarre Vestil', 'anniversary', 1, 20, 2026::smallint)
)
insert into public.home_celebrations (
  display_name,
  event_type,
  event_month,
  event_day,
  start_year
)
select
  source.display_name,
  source.event_type,
  source.event_month,
  source.event_day,
  source.start_year
from org_chart_celebrations source
where not exists (
  select 1
  from public.home_celebrations existing
  where existing.display_name = source.display_name
    and existing.event_type = source.event_type
);
