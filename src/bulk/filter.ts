import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Stage, Status } from '../crm/pipeline';

/**
 * Which deals a bulk move covers. Every criterion is optional, and they combine with AND; within a
 * list the values combine with OR. Value bounds are inclusive. `createdFrom` is inclusive and
 * `createdTo` exclusive, so consecutive ranges never overlap.
 */
export interface BulkFilter {
  stages?: Stage[];
  ownerIds?: string[];
  statuses?: Status[];
  minValueCents?: number;
  maxValueCents?: number;
  createdFrom?: string;
  createdTo?: string;
}

/**
 * The canonical form of a filter: lists sorted and de-duplicated, ids lower-cased, instants in UTC,
 * keys in a fixed order. Requests that mean the same thing then store and hash identically, so a
 * retry that happens to list stages in another order is still recognised as the same request.
 */
export function normalizeFilter(input: BulkFilter): BulkFilter {
  const filter: BulkFilter = {};
  if (input.stages) filter.stages = sortedUnique(input.stages);
  if (input.ownerIds) filter.ownerIds = sortedUnique(input.ownerIds.map((id) => id.toLowerCase()));
  if (input.statuses) filter.statuses = sortedUnique(input.statuses);
  if (input.minValueCents !== undefined) filter.minValueCents = input.minValueCents;
  if (input.maxValueCents !== undefined) filter.maxValueCents = input.maxValueCents;
  if (input.createdFrom !== undefined) filter.createdFrom = toUtc(input.createdFrom, 'createdFrom');
  if (input.createdTo !== undefined) filter.createdTo = toUtc(input.createdTo, 'createdTo');

  if (
    filter.minValueCents !== undefined &&
    filter.maxValueCents !== undefined &&
    filter.minValueCents > filter.maxValueCents
  ) {
    throw new BadRequestException('minValueCents must not be greater than maxValueCents');
  }
  if (filter.createdFrom && filter.createdTo && filter.createdFrom >= filter.createdTo) {
    throw new BadRequestException('createdFrom must be earlier than createdTo');
  }
  return filter;
}

/** What the idempotency key is checked against: the normalised filter plus the target stage. */
export function hashRequest(filter: BulkFilter, targetStage: Stage): string {
  return createHash('sha256').update(JSON.stringify({ filter, targetStage })).digest('hex');
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}

function toUtc(value: string, field: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new BadRequestException(`${field} is not a valid date`);
  }
  // toISOString() always has the same shape, so normalised instants also compare as strings.
  return instant.toISOString();
}
