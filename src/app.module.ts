import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { BulkModule } from './bulk/bulk.module';
import { ConfigModule } from './config.module';
import { CrmModule } from './crm/crm.module';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [ConfigModule, DatabaseModule, CrmModule, BulkModule],
  controllers: [HealthController],
  providers: [
    {
      // Registered as a provider (not in main.ts) so tests that boot AppModule get it too.
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
