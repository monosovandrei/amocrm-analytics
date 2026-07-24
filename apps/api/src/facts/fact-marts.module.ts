import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FactMartsService } from './fact-marts.service';

@Module({
  imports: [PrismaModule],
  providers: [FactMartsService],
  exports: [FactMartsService],
})
export class FactMartsModule {}
