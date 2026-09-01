import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DataQualityService } from './data-quality.service';

@Controller('quality')
@UseGuards(JwtAuthGuard)
export class DataQualityController {
  constructor(private readonly quality: DataQualityService) {}

  @Get('status')
  status() {
    return this.quality.status();
  }

  @Get('incidents/:id')
  async incident(@Param('id') id: string) {
    const incident = await this.quality.incident(id);
    if (!incident) throw new NotFoundException('Инцидент не найден');
    return incident;
  }
}
