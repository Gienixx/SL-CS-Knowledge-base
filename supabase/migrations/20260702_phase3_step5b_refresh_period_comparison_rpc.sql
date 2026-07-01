begin;

grant execute
on function public.get_dashboard_period_comparison(
  date,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
)
to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
