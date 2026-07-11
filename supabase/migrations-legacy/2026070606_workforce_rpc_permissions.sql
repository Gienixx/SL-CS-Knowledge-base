-- Correct workforce RPC execution privileges in environments where the
-- permission-service migration was already applied.
--
-- Supabase can grant EXECUTE directly to anon, so revoking only PostgreSQL
-- PUBLIC privileges is insufficient.

revoke execute on function public.workforce_get_current_access() from anon;
revoke all on function public.workforce_get_current_access() from public;
grant execute on function public.workforce_get_current_access() to authenticated;
