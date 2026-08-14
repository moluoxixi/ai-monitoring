import { Body, Controller, Get, Put } from '@nestjs/common';
import { UpdateNotificationSettingsDto } from './dto/update-notification-settings.dto';
import { UserSettingsService } from './user-settings.service';

@Controller('api/notification-settings')
export class SettingsController {
  constructor(private readonly settings: UserSettingsService) {}

  @Get()
  get() {
    return this.settings.notification();
  }

  @Put()
  update(@Body() body: UpdateNotificationSettingsDto) {
    return this.settings.updateNotification(body);
  }
}
