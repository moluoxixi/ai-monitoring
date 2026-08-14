import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../database/database.service';
import type { NormalizedEvent } from '../database/database.types';
import { cleanAnswerText } from './event-text';

@Injectable()
export class EventIngestionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
  ) {}

  ingest(event: NormalizedEvent, channels: string[], answerSource?: unknown): [number, boolean] {
    const metadataSource = event.metadata.answer_source;
    delete event.metadata.answer_source;
    delete event.metadata.answer_text;
    const source = typeof answerSource === 'string'
      ? answerSource
      : typeof metadataSource === 'string' ? metadataSource : '';
    if (event.status === 'completed' && source) event.metadata.answer_text = cleanAnswerText(source);
    const deliveryDelay = event.status === 'completed' ? this.config.answerCaptureGraceMs : 0;
    const [eventId, inserted] = this.database.insertEvent(event, channels, deliveryDelay);
    return [eventId, inserted];
  }
}
