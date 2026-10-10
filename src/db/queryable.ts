import type { QueryResult, QueryResultRow } from 'pg';

/** The part of Pool and PoolClient that query helpers need, so they run in or out of a transaction. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** For statements that must return exactly one row, such as INSERT ... RETURNING. */
export function oneRow<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined || rows.length > 1) {
    throw new Error(`expected exactly one row, got ${rows.length}`);
  }
  return row;
}
