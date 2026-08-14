import { Type } from 'class-transformer';
import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateEventDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  source!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  event_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  client?: string;

  /**
   * Optional runtime assertion for a canonical client key. CLI, Desktop and
   * Quest are separate keys; this field never converts a legacy or short name.
   */
  @IsOptional()
  @IsIn(['cli', 'desktop', 'quest'])
  runtime?: 'cli' | 'desktop' | 'quest';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  kind?: string = 'unknown';

  @IsOptional()
  @IsString()
  @MaxLength(30)
  status?: string = 'unknown';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24_000)
  message?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  error_code?: string;

  @IsOptional()
  @IsObject()
  @Type(() => Object)
  metadata?: Record<string, unknown> = {};
}
