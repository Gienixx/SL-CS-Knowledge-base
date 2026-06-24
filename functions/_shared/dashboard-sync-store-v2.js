export const UPSERT_BATCH_SIZE = 1000

export function getConflictTarget(destination) {
  const columns = Array.isArray(destination?.conflictColumns)
    ? destination.conflictColumns
    : [destination?.conflictColumn]

  if (
    columns.length === 0 ||
    columns.some(column =>
      typeof column !== 'string' ||
      !/^[a-z_][a-z0-9_]*$/i.test(column)
    )
  ) {
    throw new Error('The Supabase conflict columns are invalid.')
  }

  return columns.join(',')
}

export function getTableName(destination) {
  const tableName = destination?.tableName

  if (
    typeof tableName !== 'string' ||
    !/^[a-z_][a-z0-9_]*$/i.test(tableName)
  ) {
    throw new Error('The Supabase table name is invalid.')
  }

  return tableName
}
