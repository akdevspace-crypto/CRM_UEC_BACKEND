import { Controller, Get, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('api/v1/analytics')
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get('summaries')
  async getAiSummaries() {
    this.logger.log('Fetching AI Summaries...');
    const analytics = await this.prisma.callAnalytics.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        callSession: {
          include: {
            customer: true,
            participants: {
              where: { role: 'AGENT' }
            }
          }
        }
      }
    });

    return analytics.map((a: any) => ({
      id: a.id,
      callSession: {
        customer: {
          name: a.callSession?.customer?.name,
          phone: a.callSession?.customer?.phone
        },
        participants: a.callSession?.participants,
        duration: a.callSession?.duration
      },
      summary: a.summary,
      sentimentScore: a.sentimentScore,
      sentiment: a.sentimentScore ? (a.sentimentScore > 7 ? 'Positive' : a.sentimentScore < 4 ? 'Negative' : 'Neutral') : 'Neutral',
      customerIntent: 'General Inquiry',
      detectedLanguage: 'English',
      createdAt: a.createdAt,
      actionItems: [],
      followUpRecommendation: 'Review call details to determine next steps.'
    }));
  }
}
