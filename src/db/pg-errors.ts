import { DatabaseError } from 'pg';

export const PgErrorCode = {
  ForeignKeyViolation: '23503',
  UniqueViolation: '23505',
} as const;

/** Narrow a thrown value to a Postgres error with the given SQLSTATE (and constraint, if given). */
export function isPgError(err: unknown, code: string, constraint?: string): err is DatabaseError {
  return (
    err instanceof DatabaseError &&
    err.code === code &&
    (constraint === undefined || err.constraint === constraint)
  );
}
