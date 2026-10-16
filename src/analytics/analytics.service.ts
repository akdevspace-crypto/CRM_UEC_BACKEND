import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async generateCallSummary(sessionId: string) {
    this.logger.log(`[AI-AUDIT] event=PIPELINE_START callId=${sessionId}`);

    const session = await this.prisma.callSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      this.logger.error(`[AI-AUDIT] event=PIPELINE_FAILED callId=${sessionId} error="Session not found"`);
      return;
    }

    if (session.recordingStatus !== 'READY' || !session.recordingStoragePath) {
      this.logger.error(`[AI-AUDIT] event=PIPELINE_FAILED callId=${sessionId} error="Recording not ready or path missing"`);
      return;
    }

    this.logger.log(`[AI-AUDIT] event=RECORDING_RESOLVED callId=${sessionId} storagePath=${session.recordingStoragePath} recordingStatus=${session.recordingStatus}`);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      this.logger.error(`[AI-AUDIT] event=PIPELINE_FAILED callId=${sessionId} error="GEMINI_API_KEY is not set"`);
      return;
    }

    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    this.logger.log(`[AI-AUDIT] event=MODEL_CONFIG provider=@google/genai model=${modelName} apiKeyConfigured=true authenticationMode=Developer_API_Key`);

    try {
      const supabaseUrl = process.env.SUPABASE_URL || 'https://aws-1-ap-southeast-1.pooler.supabase.com';
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy_key';
      const supabase = createClient(supabaseUrl, supabaseKey);

      const { data, error } = await supabase.storage
        .from('call-recordings')
        .createSignedUrl(session.recordingStoragePath, 3600);

      if (error || !data?.signedUrl) {
        throw new Error(`Failed to generate signed URL: ${error?.message}`);
      }

      const audioUrl = data.signedUrl;

      this.logger.log(`[AI-AUDIT] event=TRANSCRIPTION_START callId=${sessionId}`);
      
      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) throw new Error(`Failed to fetch audio: ${audioRes.statusText}`);
      
      const arrayBuffer = await audioRes.arrayBuffer();
      const base64Audio = Buffer.from(arrayBuffer).toString('base64');
      
      this.logger.log(`[AI-AUDIT] event=TRANSCRIPTION_COMPLETE callId=${sessionId}`);
      this.logger.log(`[AI-AUDIT] event=SUMMARY_START callId=${sessionId}`);

      const ai = new GoogleGenAI({ apiKey });
      const prompt = `
      Analyze the following customer service call audio for an ElderCare CRM.
      
      Please provide a JSON response with the following strictly formatted fields:
      {
        "summary": "A detailed chronological summary from call connected to end what they are speaking.",
        "sentiment": "POSITIVE, NEUTRAL, or NEGATIVE",
        "escalationRisk": "LOW, MEDIUM, or HIGH"
      }
      
      Respond ONLY with valid JSON.
      `;

      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          {
            inlineData: {
              data: base64Audio,
              mimeType: 'video/mp4'
            }
          },
          prompt
        ],
        config: {
          responseMimeType: "application/json"
        }
      });

      this.logger.log(`[AI-AUDIT] event=SUMMARY_COMPLETE callId=${sessionId}`);
      this.logger.log(`[AI-AUDIT] event=SENTIMENT_COMPLETE callId=${sessionId}`);

      const result = JSON.parse(response.text || '{}');

      let sentimentScoreNum = 5;
      if (result.sentiment === 'POSITIVE') sentimentScoreNum = 9;
      else if (result.sentiment === 'NEGATIVE') sentimentScoreNum = 2;

      await this.prisma.callAnalytics.upsert({
        where: { callSessionId: sessionId },
        create: {
          callSessionId: sessionId,
          summary: result.summary,
          sentimentScore: sentimentScoreNum,
        },
        update: {
          summary: result.summary,
          sentimentScore: sentimentScoreNum,
        }
      });

      this.logger.log(`[AI-AUDIT] event=DATABASE_PERSISTED callId=${sessionId}`);
      this.logger.log(`[AI-AUDIT] event=PIPELINE_COMPLETE callId=${sessionId}`);

      return result;
    } catch (err) {
      this.logger.error(`[AI-AUDIT] event=PIPELINE_FAILED stage=Processing callId=${sessionId} error="${err.message}"`);
    }
  }
}
