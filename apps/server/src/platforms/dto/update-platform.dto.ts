import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdatePlatformDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  channel?: string | null;
}
