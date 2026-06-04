import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateStageProbabilityDto {
  @IsString()
  stageId!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  manualPercent?: number | null;
}
