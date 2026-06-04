import { IsString, Matches, MaxLength } from 'class-validator';

export class OAuthUrlDto {
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-zA-Z0-9-]+(\.amocrm\.(ru|com))?$/)
  subdomain!: string;
}
