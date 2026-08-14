import { IsArray, IsString, ArrayUnique } from 'class-validator';

export class UpdateVisibleExtensionsDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  visibleExtensions!: string[];
}
