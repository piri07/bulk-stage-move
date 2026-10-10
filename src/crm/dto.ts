import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { UUID_PATTERN } from '../common/uuid';
import { STAGES, STATUSES, type Stage, type Status } from './pipeline';

// Ten trillion dollars in cents: beyond any real deal, and well inside 2^53.
export const MAX_VALUE_CENTS = 1_000_000_000_000_000;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export class CreateOpportunityDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsInt()
  @Min(0)
  @Max(MAX_VALUE_CENTS)
  valueCents!: number;

  @IsString()
  @Matches(UUID_PATTERN, { message: 'ownerId must be a UUID' })
  ownerId!: string;

  @IsOptional()
  @IsIn(STAGES)
  stage?: Stage;

  @IsOptional()
  @IsIn(STATUSES)
  status?: Status;
}

export class ListOpportunitiesQuery {
  @IsIn(STAGES)
  stage!: Stage;

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
