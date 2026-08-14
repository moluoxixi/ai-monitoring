import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  MAX_RESULT_LIMIT,
  MAX_TASK_LIMIT,
  MIN_RESULT_LIMIT,
  MIN_TASK_LIMIT,
} from '../user-settings.types';

export class UpdateNotificationSettingsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_TASK_LIMIT)
  @Max(MAX_TASK_LIMIT)
  taskLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_RESULT_LIMIT)
  @Max(MAX_RESULT_LIMIT)
  resultLimit?: number;
}
