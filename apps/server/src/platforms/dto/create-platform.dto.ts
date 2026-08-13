import { IsArray, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreatePlatformDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,39}$/)
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases: string[] = [];

}
