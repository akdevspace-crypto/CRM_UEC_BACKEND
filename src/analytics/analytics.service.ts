import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly activeJobs = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  async generateCallSummary(sessionId: string) {
    if (this.activeJobs.has(sessionId)) {
      this.logger.warn(`[AI-AUDIT] event=CONCURRENT_JOB_IGNORED callId=${sessionId} reason="Session is already being processed"`);
      return null;
    }

    this.activeJobs.add(sessionId);

    try {
      this.logger.log(`[AI-AUDIT] event=PIPELINE_START callId=${sessionId}`);

      const session = await this.prisma.callSession.findUnique({
        where: { id: sessionId },
        include: { conversation: true },
      });

      if (!session) {
        this.logger.error(`[AI-AUDIT] event=PIPELINE_FAILED callId=${sessionId} error="Session not found"`);
        return null;
      }

      // Check if this session is already completed with analytics
      const existingAnalytics = await this.prisma.callAnalytics.findFirst({
        where: { callSessionId: sessionId },
      });

      if (existingAnalytics && session.aiProcessingStatus === 'COMPLETED') {
        this.logger.log(`[AI-AUDIT] event=ALREADY_COMPLETED callId=${sessionId} skipping redundant processing`);
        return existingAnalytics;
      }

      if (session.recordingStatus !== 'READY' || !session.recordingStoragePath) {
        this.logger.error(`[AI-AUDIT] event=PIPELINE_FAILED callId=${sessionId} error="Recording not ready or path missing"`);
        if (!existingAnalytics) {
          await this.prisma.callSession.update({
            where: { id: sessionId },
            data: { aiProcessingStatus: 'FAILED' }
          }).catch(() => {});
        }
        return null;
      }

      this.logger.log(`[AI-AUDIT] event=RECORDING_RESOLVED callId=${sessionId} storagePath=${session.recordingStoragePath} recordingStatus=${session.recordingStatus}`);

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        this.logger.error(`[AI-AUDIT] event=PIPELINE_FAILED callId=${sessionId} error="GEMINI_API_KEY is not set"`);
        if (!existingAnalytics) {
          await this.prisma.callSession.update({
            where: { id: sessionId },
            data: { aiProcessingStatus: 'FAILED' }
          }).catch(() => {});
        }
        return null;
      }

      // Filter out retired models to avoid unnecessary 404 errors
      const retiredModels = new Set(['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-3.0-flash']);
      const configuredModel = process.env.GEMINI_MODEL;
      const candidateModels = Array.from(
        new Set([configuredModel, 'gemini-3.8-flash', 'gemini-3.5-flash'].filter(m => m && !retiredModels.has(m))),
      ) as string[];

      if (candidateModels.length === 0) {
        candidateModels.push('gemini-3.8-flash', 'gemini-3.5-flash');
      }

      this.logger.log(
        `[AI-AUDIT] event=MODEL_CONFIG provider=@google/genai candidates=${candidateModels.join(
          ',',
        )} apiKeyConfigured=true authenticationMode=Developer_API_Key`,
      );

      await this.prisma.callSession.update({
        where: { id: sessionId },
        data: { aiProcessingStatus: 'ANALYZING' }
      }).catch(() => {});

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

      let responseText: string | null = null;
      let lastError: any = null;

      for (const model of candidateModels) {
        this.logger.log(`[AI-AUDIT] event=MODEL_ATTEMPT model=${model} callId=${sessionId}`);
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
          attempts++;
          try {
            const response = await ai.models.generateContent({
              model,
              contents: [
                {
                  inlineData: {
                    data: base64Audio,
                    mimeType: 'video/mp4',
                  },
                },
                prompt,
              ],
              config: {
                responseMimeType: 'application/json',
              },
            });

            if (response && response.text) {
              responseText = response.text;
              this.logger.log(
                `[AI-AUDIT] event=MODEL_SUCCESS model=${model} attempts=${attempts} callId=${sessionId}`,
              );
              break;
            }
          } catch (e: any) {
            lastError = e;
            const isTransient =
              e.message?.includes('503') ||
              e.message?.includes('429') ||
              e.message?.includes('high demand') ||
              e.message?.includes('UNAVAILABLE');
            this.logger.warn(
              `[AI-AUDIT] event=MODEL_RETRY model=${model} attempt=${attempts}/${maxAttempts} isTransient=${isTransient} error="${e.message}"`,
            );
            if (isTransient && attempts < maxAttempts) {
              const jitter = Math.floor(Math.random() * 500);
              await new Promise((r) => setTimeout(r, attempts * 2000 + jitter));
            } else {
              break;
            }
          }
        }

        if (responseText) break;
      }

      if (!responseText) {
        throw new Error(lastError?.message || 'Failed to generate summary with all candidate models');
      }

      this.logger.log(`[AI-AUDIT] event=SUMMARY_COMPLETE callId=${sessionId}`);
      this.logger.log(`[AI-AUDIT] event=SENTIMENT_COMPLETE callId=${sessionId}`);

      const result = JSON.parse(responseText || '{}');

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

      await this.prisma.callSession.update({
        where: { id: sessionId },
        data: { aiProcessingStatus: 'COMPLETED' }
      }).catch(() => {});

      this.logger.log(`[AI-AUDIT] event=DATABASE_PERSISTED callId=${sessionId}`);
      this.logger.log(`[AI-AUDIT] event=PIPELINE_COMPLETE callId=${sessionId}`);

      return result;
    } catch (err: any) {
      const existing = await this.prisma.callAnalytics.findFirst({
        where: { callSessionId: sessionId }
      }).catch(() => null);

      if (!existing) {
        await this.prisma.callSession.update({
          where: { id: sessionId },
          data: { aiProcessingStatus: 'FAILED' }
        }).catch(() => {});
      }
      this.logger.error(`[AI-AUDIT] event=PIPELINE_FAILED stage=Processing callId=${sessionId} error="${err.message}"`);
      return null;
    } finally {
      this.activeJobs.delete(sessionId);
    }
  }
}
