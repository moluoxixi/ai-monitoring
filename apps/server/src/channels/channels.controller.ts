import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ChannelsService } from './channels.service';
import { BindChannelDto } from './dto/bind-channel.dto';

@Controller('api/channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  getChannels() {
    return this.channels.status();
  }

  @Post(':channel/binding/start')
  async startBinding(@Param('channel') channel: string) {
    return this.channels.startBinding(channel);
  }

  @Post(':channel/binding/wait')
  async waitBinding(@Param('channel') channel: string) {
    return this.channels.waitBinding(channel);
  }

  @Put(':channel/binding')
  async bindCredential(@Param('channel') channel: string, @Body() body: BindChannelDto) {
    return this.channels.bindCredential(channel, body.values || body.credential || '');
  }

  @Delete(':channel/binding/session')
  @HttpCode(200)
  async cancelBinding(@Param('channel') channel: string) {
    await this.channels.cancelBinding(channel);
    return { ok: true, channel };
  }

  @Delete(':channel/binding')
  @HttpCode(200)
  async unbind(@Param('channel') channel: string) {
    return { ok: true, channel, removed: await this.channels.unbind(channel) };
  }
}
