import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

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
