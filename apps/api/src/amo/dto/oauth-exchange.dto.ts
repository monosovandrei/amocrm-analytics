import { IsString, IsUrl, Matches, MaxLength } from 'class-validator';

export class OAuthExchangeDto {
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-zA-Z0-9-]+(\.amocrm\.(ru|com))?$/)
  subdomain!: string;

  @IsString()
  @MaxLength(4096)
  code!: string;

  @IsUrl({ require_tld: false })
  redirectUri!: string;
}
