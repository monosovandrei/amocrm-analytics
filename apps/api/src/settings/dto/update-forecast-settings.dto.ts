import { IsEnum, IsOptional, IsString, Min, IsInt } from 'class-validator';
import { ProbabilityMode } from '../../generated/prisma';

export class UpdateForecastSettingsDto {
  @IsOptional()
  @IsString()
  closingStageId?: string;

  @IsOptional()
  @IsString()
  shippingPipelineId?: string;

  @IsOptional()
  @IsString()
  shippingSuccessStageId?: string;

  @IsOptional()
  @IsEnum(ProbabilityMode)
  probabilityMode?: ProbabilityMode;

  @IsOptional()
  @IsInt()
  @Min(1)
  minSampleSize?: number;
}
