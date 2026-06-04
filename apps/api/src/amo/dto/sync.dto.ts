import { IsEnum, IsOptional } from 'class-validator';
import { SyncJobType } from '../../generated/prisma';

export class TriggerSyncDto {
  @IsOptional()
  @IsEnum(SyncJobType)
  type?: SyncJobType;
}
