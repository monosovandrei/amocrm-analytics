import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { ReportsModule } from './reports/reports.module';
import { ReportsSchedulerService } from './reports/reports-scheduler.service';
import { PlatformModule } from './platform/platform.module';
import { PlatformSchedulerService } from './platform/platform-scheduler.service';
import { AmoModule } from './amo/amo.module';
import { AmoSchedulerService } from './amo/amo-scheduler.service';
import { WorkerRuntimeService } from './common/worker-runtime.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuditModule,
    ReportsModule,
    PlatformModule,
    AmoModule,
  ],
  providers: [AmoSchedulerService, PlatformSchedulerService, ReportsSchedulerService, WorkerRuntimeService],
})
export class WorkerModule {}
