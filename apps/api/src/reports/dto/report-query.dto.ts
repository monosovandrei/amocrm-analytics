import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

export class ReportQueryDto {
  @IsString()
  name!: string;

  @IsIn(['EVENT', 'CURRENT'])
  sourceType!: 'EVENT' | 'CURRENT';

  @IsObject()
  filters!: Record<string, any>;

  @IsObject()
  config!: Record<string, any>;
}

export class SaveReportTemplateDto extends ReportQueryDto {
  @IsOptional()
  @IsString()
  id?: string;
}

export class ReportSnapshotsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReportQueryDto)
  reports!: ReportQueryDto[];
}
