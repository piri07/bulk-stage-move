import { Module } from '@nestjs/common';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';
import { StagesController } from './stages.controller';

@Module({
  controllers: [OpportunitiesController, StagesController],
  providers: [OpportunitiesService],
})
export class CrmModule {}
