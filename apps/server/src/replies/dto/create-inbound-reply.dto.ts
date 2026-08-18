import { Equals, IsBoolean, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateInboundReplyDto {
  @IsIn(['openclaw-qq'])
  channel!: 'openclaw-qq';

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  account_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  sender_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  message_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  text!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32_000)
  reply_to_body!: string;

  @IsBoolean()
  @Equals(true)
  reply_to_is_quote!: true;

  @IsBoolean()
  @Equals(false)
  is_group!: false;
}
