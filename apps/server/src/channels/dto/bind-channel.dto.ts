import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class BindChannelDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  credential?: string;

  @IsOptional()
  @IsObject()
  values?: Record<string, unknown>;
}
