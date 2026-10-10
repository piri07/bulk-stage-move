import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ParseIdPipe } from '../common/parse-id.pipe';
import { WorkspaceGuard, WorkspaceId } from '../common/workspace';
// DTOs must be value imports: ValidationPipe finds them through emitted decorator metadata.
import { CreateOpportunityDto, ListOpportunitiesQuery, MoveStageDto } from './dto';
import type { Opportunity } from './opportunities.repository';
import { OpportunitiesService, type OpportunityPage } from './opportunities.service';

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
  ): Promise<OpportunityPage> {
    return this.opportunities.listInStage(workspaceId, query);
  }

  @Get(':id')
  get(
    @WorkspaceId() workspaceId: string,
    @Param('id', ParseIdPipe) id: number,
  ): Promise<Opportunity> {
    return this.opportunities.get(workspaceId, id);
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
