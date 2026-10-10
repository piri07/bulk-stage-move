import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQuery } from '../common/pagination';
import { UUID_PATTERN } from '../common/uuid';
import { MAX_VALUE_CENTS } from '../crm/dto';
import { STAGES, STATUSES, type Stage, type Status } from '../crm/pipeline';

export class BulkMoveFilterDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(STAGES.length)
  @IsIn(STAGES, { each: true })
  stages?: Stage[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Matches(UUID_PATTERN, { each: true, message: 'each ownerIds entry must be a UUID' })
  ownerIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(STATUSES.length)
  @IsIn(STATUSES, { each: true })
  statuses?: Status[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_VALUE_CENTS)
  minValueCents?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_VALUE_CENTS)
  maxValueCents?: number;

  /** Deals created at or after this instant (ISO 8601). */
  @IsOptional()
  @IsISO8601({ strict: true })
  createdFrom?: string;

  /** Deals created before this instant (ISO 8601). */
  @IsOptional()
  @IsISO8601({ strict: true })
  createdTo?: string;
}

export class SubmitBulkMoveDto {
  // Required, even if empty: `{}` deliberately means "every deal in the workspace".
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => BulkMoveFilterDto)
  filter!: BulkMoveFilterDto;

  @IsIn(STAGES)
  targetStage!: Stage;
}

export const JOB_ITEM_OUTCOMES = ['moved', 'skipped_conflict'] as const;

export type JobItemOutcome = (typeof JOB_ITEM_OUTCOMES)[number];

export class ListJobItemsQuery extends PageQuery {
  @IsOptional()
  @IsIn(JOB_ITEM_OUTCOMES)
  outcome?: JobItemOutcome;
}
