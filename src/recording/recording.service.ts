import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class RecordingService {
  private readonly logger = new Logger(RecordingService.name);

  async startRecording(sessionId: string, transportId: string) {
    this.logger.log(`[CALL-RECORDING] provider=legacy_mediasoup callId=${sessionId}`);
    this.logger.log(`Starting FFmpeg recording for session ${sessionId}...`);
    // Connect to Mediasoup PlainTransport and pipe RTP streams to FFmpeg
  }

  async stopAndUpload(sessionId: string) {
    this.logger.log(
      `Stopping recording and uploading to S3/Supabase for session ${sessionId}...`,
    );
    // Kill FFmpeg process, run compression, upload to bucket
    return `https://storage.enterprise.com/records/${sessionId}.mp3`;
  }
}
