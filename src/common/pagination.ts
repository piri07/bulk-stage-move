import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Keyset pagination parameters shared by every listing. */
export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = DEFAULT_PAGE_SIZE;

  /** The id of the last item of the previous page. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  cursor?: number;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: number | null;
}

/**
 * Builds a page from a query that fetched `limit + 1` rows in cursor order. The extra row only
 * signals that another page exists, which saves a COUNT.
 */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? cursorOf(last) : null };
}
