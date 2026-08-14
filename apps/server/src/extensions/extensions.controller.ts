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
    return {
      channels: channelData,
      extensions: this.extensions.cards(snapshot.platforms).map((definition) => ({
        ...this.card(definition, settings.monitorVerification[definition.key]),
        event_count: this.database.countEvents(definition.key),
      })),
      visibleExtensions: this.visibleExtensions(snapshot),
      scanScope: snapshot.scanScope,
      scannedAt: snapshot.scannedAt,
    };
  }

  @Post('scan')
  scan() {
    this.scanner.scan();
    return this.list();
  }

  @Put('preferences')
  savePreferences(@Body() body: UpdateVisibleExtensionsDto) {
    const supported = this.extensions.definitions().map((extension) => extension.key);
    const visibleExtensions = this.settings.updateVisibleExtensions(body.visibleExtensions, supported);
    return { visibleExtensions };
  }

  private visibleExtensions(snapshot: ReturnType<PlatformScannerService['snapshot']>): string[] {
    const supported = this.extensions.definitions().map((extension) => extension.key);
    const settings = this.settings.snapshot();
    if (settings.hasVisiblePreference) {
      const selected = settings.visibleExtensions.filter((key) => supported.includes(key));
      if (selected.length) return selected;
    }
    const detected = supported.filter((key) => snapshot.platforms[key]?.detected);
    return detected.length ? detected : supported;
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
