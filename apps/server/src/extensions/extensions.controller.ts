import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import { DatabaseService } from '../database/database.service';
import { UserSettingsService } from '../settings/user-settings.service';
import { UpdateVisibleExtensionsDto } from '../settings/dto/update-visible-extensions.dto';
import type { ExtensionDefinition } from './extension.types';
import { PlatformScannerService } from './platform-scanner.service';
import { ExtensionsService } from './extensions.service';

@Controller('api/extensions')
export class ExtensionsController {
  constructor(
    private readonly extensions: ExtensionsService,
    private readonly channels: ChannelsService,
    private readonly database: DatabaseService,
    private readonly scanner: PlatformScannerService,
    private readonly settings: UserSettingsService,
  ) {}

  @Get()
  async list() {
    const channelData = await this.channels.status();
    const snapshot = this.scanner.snapshot();
    const settings = this.settings.snapshot();
    const configurableExtensions = this.extensions.configurableKeys(snapshot);
    const visibleExtensions = this.extensions.effectiveVisibleKeys(snapshot, settings);
    return {
      channels: channelData,
      extensions: this.extensions.cards(snapshot.platforms).map((definition) => ({
        ...this.card(definition, settings.monitorVerification[definition.key]),
        event_count: this.database.countEvents(definition.key),
      })),
      visibleEventCount: visibleExtensions.reduce((total, key) => total + this.database.countEvents(key), 0),
      configurableExtensions,
      visibleExtensions,
      scanScope: snapshot.scanScope,
      scanStatus: snapshot.scanStatus,
      scannedAt: snapshot.scannedAt,
      device: snapshot.device,
    };
  }

  @Post('scan')
  scan() {
    this.scanner.scan();
    return this.list();
  }

  @Put('preferences')
  savePreferences(@Body() body: UpdateVisibleExtensionsDto) {
    const configurableExtensions = this.extensions.configurableKeys(this.scanner.snapshot());
    const visibleExtensions = this.settings.updateVisibleExtensions(body.visibleExtensions, configurableExtensions);
    return { visibleExtensions };
  }

  private card(definition: ExtensionDefinition & {
    detected: boolean;
    cliAvailable: boolean;
    running: boolean;
    monitorConfigured: boolean;
    detectionSignals: string[];
  }, verification?: {
    monitorVerified: true;
    lastVerifiedAt: string;
    verificationSource: string;
  }) {
    return {
      key: definition.key,
      product: definition.product,
      runtime: definition.runtime,
      label: definition.label,
      adapter: definition.adapter,
      detected: definition.detected,
      cliAvailable: definition.cliAvailable,
      running: definition.running,
      monitorConfigured: definition.monitorConfigured,
      monitorVerified: verification?.monitorVerified === true,
      lastVerifiedAt: verification?.lastVerifiedAt || null,
      verificationSource: verification?.verificationSource || null,
      detectionSignals: definition.detectionSignals,
    };
  }

}
