import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
// DTOs (here and below) must be value imports: ValidationPipe finds them through emitted
// decorator metadata.
import { PageQuery, type Page } from '../common/pagination';
import { ParseIdPipe } from '../common/parse-id.pipe';
import { WorkspaceGuard, WorkspaceId } from '../common/workspace';
import { CreateOpportunityDto, ListOpportunitiesQuery, MoveStageDto } from './dto';
import type { Opportunity, StageTransition } from './opportunities.repository';
import { OpportunitiesService } from './opportunities.service';

@Controller('opportunities')
@UseGuards(WorkspaceGuard)
export class OpportunitiesController {
  constructor(private readonly opportunities: OpportunitiesService) {}

  @Post()
  create(
    @WorkspaceId() workspaceId: string,
    @Body() dto: CreateOpportunityDto,
  ): Promise<Opportunity> {
    return this.opportunities.create(workspaceId, dto);
  }

  @Get()
  list(
    @WorkspaceId() workspaceId: string,
    @Query() query: ListOpportunitiesQuery,
  ): Promise<Page<Opportunity>> {
    return this.opportunities.listInStage(workspaceId, query);
  }

  @Get(':id')
  get(
    @WorkspaceId() workspaceId: string,
    @Param('id', ParseIdPipe) id: number,
  ): Promise<Opportunity> {
    return this.opportunities.get(workspaceId, id);
  }

  @Get(':id/transitions')
  listTransitions(
    @WorkspaceId() workspaceId: string,
    @Param('id', ParseIdPipe) id: number,
    @Query() query: PageQuery,
  ): Promise<Page<StageTransition>> {
    return this.opportunities.listTransitions(workspaceId, id, query);
  }

  @Patch(':id/stage')
  moveStage(
    @WorkspaceId() workspaceId: string,
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: MoveStageDto,
  ): Promise<Opportunity> {
    return this.opportunities.moveStage(workspaceId, id, dto);
  }
}
