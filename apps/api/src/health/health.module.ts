import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { QualityModule } from '../quality/quality.module';

@Module({
  imports: [QualityModule],
  controllers: [HealthController],
})
export class HealthModule {}
