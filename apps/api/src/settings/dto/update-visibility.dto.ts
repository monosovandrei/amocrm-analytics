import { IsArray, IsBoolean, IsString } from 'class-validator';

export class VisibilityItemDto {
  @IsString()
  id!: string;

  @IsBoolean()
  isVisible!: boolean;
}

export class UpdateVisibilityDto {
  @IsArray()
  managers!: VisibilityItemDto[];

  @IsArray()
  groups!: VisibilityItemDto[];
}
