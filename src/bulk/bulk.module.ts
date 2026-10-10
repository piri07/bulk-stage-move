import { Module } from '@nestjs/common';
import { BulkMovesController } from './bulk-moves.controller';
import { BulkMovesService } from './bulk-moves.service';

@Module({
  controllers: [BulkMovesController],
  providers: [BulkMovesService],
})
export class BulkModule {}
