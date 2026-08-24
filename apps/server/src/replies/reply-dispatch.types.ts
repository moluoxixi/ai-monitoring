export interface ReplyDispatchResult {
  threadId: string;
  turnId: string;
  writerReleased: Promise<void>;
  cancel?: () => void;
}
