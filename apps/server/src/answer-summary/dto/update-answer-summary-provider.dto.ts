import { IsBoolean, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class UpdateAnswerSummaryProviderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4_096)
  apiKey?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  model!: string;

  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'], require_tld: false })
  @MaxLength(2_000)
  baseUrl?: string;

  @IsBoolean()
  enabled!: boolean;
}
