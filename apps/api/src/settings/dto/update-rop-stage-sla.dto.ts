import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';

export class UpdateRopStageSlaDto {
  @IsIn(['sales', 'csm'])
  departmentKey!: 'sales' | 'csm';

  @IsString()
  stageId!: string;

  @IsBoolean()
  isEnabled!: boolean;

  @ValidateIf((item) => item.isEnabled)
  @IsInt()
  @Min(1)
  @Max(365)
  slaDays?: number;

  @IsOptional()
  @IsString()
  reason?: string | null;
}
