create index if not exists workforce_deleted_reinvite_requested_by_idx
  on private.workforce_deleted_employee_reinvites (requested_by);
