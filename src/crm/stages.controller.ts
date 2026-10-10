import { Controller, Get } from '@nestjs/common';
import { STAGES, type Stage } from './pipeline';

/** The pipeline is global, so this route needs no workspace. */
@Controller('stages')
export class StagesController {
  @Get()
  list(): { stages: { key: Stage; position: number }[] } {
    return { stages: STAGES.map((key, position) => ({ key, position })) };
  }
}
