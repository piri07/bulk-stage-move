import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { PageQuery } from '../common/pagination';
import { UUID_PATTERN } from '../common/uuid';
import { STAGES, STATUSES, type Stage, type Status } from './pipeline';

// Ten trillion dollars in cents: beyond any real deal, and well inside 2^53.
export const MAX_VALUE_CENTS = 1_000_000_000_000_000;

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

export class MoveStageDto {
  @IsIn(STAGES)
  stage!: Stage;

  /** Optimistic concurrency: when given, the move only applies if the deal is still at it. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  expectedVersion?: number;
}

export class ListOpportunitiesQuery extends PageQuery {
  @IsIn(STAGES)
  stage!: Stage;
}
