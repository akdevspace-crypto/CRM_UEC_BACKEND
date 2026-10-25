import { Controller, Get, Post, Param, Query, Logger, Req, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

@Controller(['api/v1/analytics', 'api/v1/dashboard', 'dashboard'])
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  @Get('summaries')
  async getAiSummaries(@Req() req: any) {
    this.logger.log('Fetching AI Summaries...');

    const user = req?.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user.role);

    const whereClause: any = {};
    if (!isElevated && user) {
      whereClause.callSession = {
        OR: [
          { callerUserId: user.userId },
          { calleeUserId: user.userId },
          {
            participants: {
              some: {
                OR: [
                  { agentId: user.agentId },
                  { agentId: user.id },
                ]
              }
            }
          }
        ]
      };
    }

    const analytics = await this.prisma.callAnalytics.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        callSession: {
          include: {
            customer: true,
            caller: {
              select: {
                email: true,
                agentProfile: { select: { name: true } }
              }
            },
            callee: {
              select: {
                email: true,
                agentProfile: { select: { name: true } }
              }
            },
            participants: {
              where: { role: 'AGENT' }
            }
          }
        }
      }
    });

    const jwt = require('jsonwebtoken');
    const jwtSecret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';

    const forwardedHost = req?.headers?.['x-forwarded-host'];
    const host = Array.isArray(forwardedHost) ? forwardedHost[0] : (forwardedHost || (req?.get ? req.get('host') : null) || 'crm-uec-backend.onrender.com');
    const protocol = req?.headers?.['x-forwarded-proto'] || req?.protocol || 'https';
    const baseUrl = process.env.BACKEND_PUBLIC_URL || `${protocol}://${host}`;

    return analytics.map((a: any) => {
      const callSession = a.callSession;
      const callId = callSession?.id || a.callSessionId;
      const recordingStatus = callSession?.recordingStatus || (callSession?.recordingUrl ? 'READY' : 'NOT_AVAILABLE');
      const recordingDuration = callSession?.recordingDuration || callSession?.duration || a.duration || 0;

      let tokenQuery = '';
      if (callId && user && (user.userId || user.id || user.sub)) {
        try {
          const token = jwt.sign(
            {
              sub: user.userId || user.id || user.sub,
              userId: user.userId || user.id || user.sub,
              role: user.role,
              callId: callId,
            },
            jwtSecret,
            { expiresIn: '2h' }
          );
          tokenQuery = `?token=${token}`;
        } catch (_) {}
      }

      const recordingUrl = (recordingStatus === 'READY' && callId)
        ? `${baseUrl}/telephony/calls/${callId}/recording${tokenQuery}`
        : (callSession?.recordingUrl || null);

      return {
        id: a.id,
        callSessionId: callId,
        callId: callId,
        callSession: {
          id: callId,
          customer: {
            name: callSession?.customer?.name,
            phone: callSession?.customer?.phone,
          },
          participants: [
            {
              agent: {
                name: callSession?.caller?.agentProfile?.name || callSession?.callee?.agentProfile?.name || 'Agent',
              },
            },
          ],
          duration: callSession?.duration || 0,
          recordingStatus,
          recordingUrl,
          recordingDuration,
        },
        recordingStatus,
        recordingUrl,
        recordingDuration,
        summary: a.summary,
        sentimentScore: a.sentimentScore || 5,
        sentiment: a.sentiment || (a.sentimentScore ? (a.sentimentScore > 7 ? 'Positive' : a.sentimentScore < 4 ? 'Negative' : 'Neutral') : 'Neutral'),
        customerIntent: a.callOutcome || 'General Inquiry',
        detectedLanguage: a.language || 'English',
        originalTranscript: a.transcript || null,
        englishTranslation: a.transcript || null,
        createdAt: a.createdAt,
        actionItems: [],
        followUpRecommendation: 'Review call details to determine next steps.',
      };
    });
  }

  @Get('summaries/:callId')
  async getAiSummaryForCall(@Param('callId') callId: string, @Req() req: any) {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isUuid = UUID_REGEX.test(callId);

    const session = isUuid
      ? await this.prisma.callSession.findUnique({
          where: { id: callId },
          include: {
            analytics: true,
            customer: true,
            participants: { where: { role: 'AGENT' } },
            caller: { select: { email: true, agentProfile: { select: { name: true } } } },
            callee: { select: { email: true, agentProfile: { select: { name: true } } } },
          },
        })
      : await this.prisma.callSession.findFirst({
          where: { OR: [{ reason: callId }, { livekitRoom: callId }] },
          include: {
            analytics: true,
            customer: true,
            participants: { where: { role: 'AGENT' } },
            caller: { select: { email: true, agentProfile: { select: { name: true } } } },
            callee: { select: { email: true, agentProfile: { select: { name: true } } } },
          },
        });

    if (!session) {
      return { success: false, error: 'Call session not found', summary: null };
    }

    const a = session.analytics;
    const recordingStatus = session.recordingStatus || (session.recordingUrl ? 'READY' : 'NOT_AVAILABLE');
    const recordingDuration = session.recordingDuration || session.duration || a?.duration || 0;

    const user = req?.user;
    const jwt = require('jsonwebtoken');
    const jwtSecret = process.env.JWT_SECRET || 'crm-secure-jwt-secret-key-2026';
    const forwardedHost = req?.headers?.['x-forwarded-host'];
    const host = Array.isArray(forwardedHost) ? forwardedHost[0] : (forwardedHost || (req?.get ? req.get('host') : null) || 'crm-uec-backend.onrender.com');
    const protocol = req?.headers?.['x-forwarded-proto'] || req?.protocol || 'https';
    const baseUrl = process.env.BACKEND_PUBLIC_URL || `${protocol}://${host}`;

    let tokenQuery = '';
    if (session.id && user && (user.userId || user.id || user.sub)) {
      try {
        const token = jwt.sign(
          {
            sub: user.userId || user.id || user.sub,
            userId: user.userId || user.id || user.sub,
            role: user.role,
            callId: session.id,
          },
          jwtSecret,
          { expiresIn: '2h' }
        );
        tokenQuery = `?token=${token}`;
      } catch (_) {}
    }

    const recordingUrl = (recordingStatus === 'READY')
      ? (session.recordingUrl?.startsWith('http') ? session.recordingUrl : `${baseUrl}/telephony/calls/${session.id}/recording${tokenQuery}`)
      : (session.recordingUrl || null);

    if (!a) {
      return {
        success: true,
        callSessionId: session.id,
        aiProcessingStatus: session.aiProcessingStatus || 'PENDING',
        recordingStatus,
        recordingUrl,
        recordingDuration,
        summary: null,
      };
    }

    return {
      success: true,
      id: a.id,
      callSessionId: session.id,
      aiProcessingStatus: session.aiProcessingStatus || 'COMPLETED',
      recordingStatus,
      recordingUrl,
      recordingDuration,
      summary: a.summary,
      sentimentScore: a.sentimentScore || 5,
      sentiment: (a as any).sentiment || (a.sentimentScore ? (a.sentimentScore > 7 ? 'Positive' : a.sentimentScore < 4 ? 'Negative' : 'Neutral') : 'Neutral'),
      customerIntent: a.callOutcome || 'General Inquiry',
      detectedLanguage: a.language || 'English',
      transcript: (a as any).transcript || null,
      actionItems: ['Review customer notes', 'Follow up if requested'],
    };
  }

  @Post('calls/:callId/reprocess')
  async reprocessCallSummary(@Param('callId') callId: string, @Req() req: any) {
    const user = req?.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user.role);

    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isUuid = UUID_REGEX.test(callId);

    const session = isUuid
      ? await this.prisma.callSession.findUnique({
          where: { id: callId },
          include: { participants: true },
        })
      : await this.prisma.callSession.findFirst({
          where: { OR: [{ reason: callId }, { livekitRoom: callId }] },
          include: { participants: true },
        });

    if (!session) {
      throw new NotFoundException('Call session not found');
    }

    if (!isElevated) {
      const isCaller = session.callerUserId === user?.userId || session.callerUserId === user?.id || session.callerUserId === user?.sub;
      const isCallee = session.calleeUserId === user?.userId || session.calleeUserId === user?.id || session.calleeUserId === user?.sub;
      const isParticipant = session.participants?.some(
        (p: any) => p.agentId === user?.agentId || p.agentId === user?.userId || p.agentId === user?.id || p.agentId === user?.sub
      );

      if (!isCaller && !isCallee && !isParticipant) {
        throw new ForbiddenException('Forbidden: You do not have permission to reprocess this call');
      }
    }

    this.logger.log(`[AI-AUDIT] Explicit reprocess requested for callId=${session.id} by user=${user?.userId || user?.sub}`);
    const result = await this.analyticsService.generateCallSummary(session.id);
    return { success: true, result };
  }

  @Post('repair-pending')
  async repairPendingSummaries(@Query('limit') limit?: string, @Req() req?: any) {
    const user = req?.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER'].includes(user.role);
    if (!isElevated) {
      throw new ForbiddenException('Forbidden: Only elevated administrators can run summary repair');
    }
    const batchSize = limit ? parseInt(limit, 10) : 3;
    const result = await this.analyticsService.repairPendingSummaries(batchSize);
    return { success: true, ...result };
  }

  @Get('ai-usage')
  async getAiUsageMetrics(
    @Query('period') period?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Req() req?: any,
  ) {
    const where: any = {};

    let fromDate: Date | null = null;
    let toDate: Date = new Date();

    if (startDate) {
      fromDate = new Date(startDate);
    } else if (period === 'today') {
      fromDate = new Date();
      fromDate.setHours(0, 0, 0, 0);
    } else if (period === '7d') {
      fromDate = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    } else if (period === '30d') {
      fromDate = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    }

    if (endDate) {
      toDate = new Date(endDate);
    }

    if (fromDate) {
      where.createdAt = {
        gte: fromDate,
        lte: toDate,
      };
    }

    const records = await (this.prisma as any).aiUsageRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 1000,
    }).catch(() => []);

    let totalPromptTokens = 0;
    let totalCandidateTokens = 0;
    let totalTokens = 0;
    let totalAudioSeconds = 0;
    let totalEstimatedCost = 0;

    const byModel: Record<string, { requests: number; promptTokens: number; candidateTokens: number; totalTokens: number; estimatedCost: number }> = {};
    const byFeature: Record<string, { requests: number; promptTokens: number; candidateTokens: number; totalTokens: number; estimatedCost: number }> = {};

    for (const r of records) {
      totalPromptTokens += r.promptTokens || 0;
      totalCandidateTokens += r.candidateTokens || 0;
      totalTokens += r.totalTokens || 0;
      totalAudioSeconds += r.audioSeconds || 0;
      totalEstimatedCost += r.estimatedCost || 0;

      const m = r.model || 'unknown';
      if (!byModel[m]) byModel[m] = { requests: 0, promptTokens: 0, candidateTokens: 0, totalTokens: 0, estimatedCost: 0 };
      byModel[m].requests++;
      byModel[m].promptTokens += r.promptTokens || 0;
      byModel[m].candidateTokens += r.candidateTokens || 0;
      byModel[m].totalTokens += r.totalTokens || 0;
      byModel[m].estimatedCost += r.estimatedCost || 0;

      const f = r.feature || 'general';
      if (!byFeature[f]) byFeature[f] = { requests: 0, promptTokens: 0, candidateTokens: 0, totalTokens: 0, estimatedCost: 0 };
      byFeature[f].requests++;
      byFeature[f].promptTokens += r.promptTokens || 0;
      byFeature[f].candidateTokens += r.candidateTokens || 0;
      byFeature[f].totalTokens += r.totalTokens || 0;
      byFeature[f].estimatedCost += r.estimatedCost || 0;
    }

    const pricingConfig = {
      version: '2026-v1',
      provider: 'Google Gemini',
      models: {
        'gemini-3.5-flash': { inputPer1M: 0.075, outputPer1M: 0.30 },
        'gemini-3.8-flash': { inputPer1M: 0.075, outputPer1M: 0.30 },
      },
      note: 'Costs estimated from provider-reported prompt & candidate tokens using published pricing schedules.'
    };

    return {
      success: true,
      period: period || 'all',
      range: {
        from: fromDate?.toISOString() || null,
        to: toDate.toISOString(),
      },
      summary: {
        totalRequests: records.length,
        totalPromptTokens,
        totalCandidateTokens,
        totalTokens,
        totalAudioSeconds,
        totalAudioMinutes: (totalAudioSeconds / 60).toFixed(1),
        estimatedCostUsd: Number(totalEstimatedCost.toFixed(6)),
        costType: 'ESTIMATED',
        authoritativeLiveCredits: null,
      },
      byModel,
      byFeature,
      pricingConfig,
    };
  }

  private static inFlightRawMetrics: Promise<any> | null = null;
  private static cachedRawMetrics: { timestamp: number; data: any } | null = null;
  private static readonly CACHE_TTL_MS = 15000; // 15 seconds

  private async getRawMetrics(): Promise<any> {
    const now = Date.now();
    if (
      AnalyticsController.cachedRawMetrics &&
      now - AnalyticsController.cachedRawMetrics.timestamp < AnalyticsController.CACHE_TTL_MS
    ) {
      return AnalyticsController.cachedRawMetrics.data;
    }

    if (AnalyticsController.inFlightRawMetrics) {
      return AnalyticsController.inFlightRawMetrics;
    }

    AnalyticsController.inFlightRawMetrics = (async () => {
      try {
        const [countsResult, servicesResult] = await Promise.all([
          this.prisma.$queryRaw<any[]>`
            SELECT
              (SELECT COUNT(*)::int FROM "Customer") as total_customers,
              (SELECT COUNT(*)::int FROM "Lead") as total_leads,
              (SELECT COUNT(*)::int FROM "Lead" WHERE status IN ('NEW', 'IN_PROGRESS')) as active_leads,
              (SELECT COUNT(*)::int FROM "Lead" WHERE status IN ('CONVERTED', 'POSITIVE')) as converted_leads,
              (SELECT COUNT(*)::int FROM "Lead" WHERE sentiment = 'POSITIVE') as positive_leads,
              (SELECT COUNT(*)::int FROM "CallSession") as total_calls,
              (SELECT COUNT(*)::int FROM "CallSession" WHERE status = 'IN_PROGRESS') as active_calls,
              (SELECT COUNT(*)::int FROM "Agent") as total_agents,
              (SELECT COUNT(*)::int FROM "Agent" WHERE status = 'AVAILABLE') as available_agents,
              (SELECT COUNT(*)::int FROM "QueueItem" WHERE status = 'WAITING') as waiting_queue,
              (SELECT COALESCE(AVG(duration), 0)::float FROM "CallSession") as avg_duration;
          `.catch((err) => {
            this.logger.warn(`Single queryRaw failed, falling back to count queries: ${err.message}`);
            return null;
          }),
          this.prisma.lead.groupBy({
            by: ['serviceInterest'],
            _count: { id: true },
          }).catch(() => []),
        ]);

        let raw: any;
        if (countsResult && countsResult.length > 0) {
          const c = countsResult[0];
          raw = {
            totalCustomers: Number(c.total_customers) || 0,
            totalLeads: Number(c.total_leads) || 0,
            activeLeads: Number(c.active_leads) || 0,
            convertedLeads: Number(c.converted_leads) || 0,
            positiveLeads: Number(c.positive_leads) || 0,
            totalCalls: Number(c.total_calls) || 0,
            activeCalls: Number(c.active_calls) || 0,
            totalAgents: Number(c.total_agents) || 0,
            availableAgents: Number(c.available_agents) || 0,
            waitingQueue: Number(c.waiting_queue) || 0,
            avgDurationSec: Math.round(Number(c.avg_duration) || 0),
            servicesCount: servicesResult || [],
          };
        } else {
          // Graceful fallback if queryRaw is unavailable
          const [
            totalCustomers,
            totalLeads,
            activeLeads,
            convertedLeads,
            positiveLeads,
            totalCalls,
            activeCalls,
            totalAgents,
            availableAgents,
            waitingQueue,
            callDurationAgg,
          ] = await Promise.all([
            this.prisma.customer.count().catch(() => 0),
            this.prisma.lead.count().catch(() => 0),
            this.prisma.lead.count({ where: { status: { in: ['NEW', 'IN_PROGRESS'] } } }).catch(() => 0),
            this.prisma.lead.count({ where: { status: { in: ['CONVERTED', 'POSITIVE'] } } }).catch(() => 0),
            this.prisma.lead.count({ where: { sentiment: 'POSITIVE' } }).catch(() => 0),
            this.prisma.callSession.count().catch(() => 0),
            this.prisma.callSession.count({ where: { status: 'IN_PROGRESS' } }).catch(() => 0),
            this.prisma.agent.count().catch(() => 0),
            this.prisma.agent.count({ where: { status: 'AVAILABLE' } }).catch(() => 0),
            this.prisma.queueItem.count({ where: { status: 'WAITING' } }).catch(() => 0),
            this.prisma.callSession.aggregate({ _avg: { duration: true } }).catch(() => ({ _avg: { duration: 0 } })),
          ]);
          raw = {
            totalCustomers,
            totalLeads,
            activeLeads,
            convertedLeads,
            positiveLeads,
            totalCalls,
            activeCalls,
            totalAgents,
            availableAgents,
            waitingQueue,
            avgDurationSec: Math.round(callDurationAgg?._avg?.duration || 0),
            servicesCount: servicesResult || [],
          };
        }

        AnalyticsController.cachedRawMetrics = {
          timestamp: Date.now(),
          data: raw,
        };
        return raw;
      } finally {
        AnalyticsController.inFlightRawMetrics = null;
      }
    })();

    return AnalyticsController.inFlightRawMetrics;
  }

  @Get(['analytics', 'dashboard/analytics'])
  async getDashboardMetrics(@Req() req: any) {
    this.logger.log('Fetching live dashboard metrics...');
    const type = req.query?.type || 'overall';
    const raw = await this.getRawMetrics();

    const {
      totalCustomers,
      totalLeads,
      activeLeads,
      convertedLeads,
      positiveLeads,
      totalCalls,
      activeCalls,
      totalAgents,
      availableAgents,
      waitingQueue,
      servicesCount,
      avgDurationSec,
    } = raw;

    const conversionRate = totalLeads > 0 ? ((convertedLeads / totalLeads) * 100).toFixed(1) : '0';
    const avgDurationFormatted = `${Math.floor(avgDurationSec / 60)}m ${avgDurationSec % 60}s`;

    const [unreadMessages, assignedTickets, agentsListRaw, channelCounts, callSessions] = await Promise.all([
      this.prisma.message.count({ where: { status: { in: ['SENT', 'DELIVERED'] } } }).catch(() => 0),
      this.prisma.ticket.count({ where: { status: 'OPEN' } }).catch(() => 0),
      this.prisma.agent.findMany({
        take: 10,
        select: {
          id: true,
          name: true,
          department: true,
          status: true,
          _count: { select: { assignedTickets: true } }
        }
      }).catch(() => []),
      this.prisma.conversation.groupBy({
        by: ['channel'],
        _count: { id: true }
      }).catch(() => []),
      this.prisma.callSession.findMany({
        where: { startedAt: { not: null } },
        select: { startedAt: true }
      }).catch(() => [])
    ]);

    const agentsList = agentsListRaw.map((a: any, i: number) => ({
      name: a.name || `Agent ${i + 1}`,
      department: a.department || 'General',
      calls: totalCalls > 0 ? Math.round(totalCalls / (agentsListRaw.length || 1)) : 0,
      tickets: a._count?.assignedTickets || 0,
      aht: avgDurationFormatted,
      csat: '4.8',
      sla: '96%',
      status: a.status
    }));

    const channelDistribution = channelCounts.length > 0
      ? channelCounts.map((c: any) => {
          const ch = (c.channel || 'chat').toLowerCase();
          return {
            name: ch === 'whatsapp' ? 'WhatsApp' : ch === 'instagram' ? 'Instagram' : ch === 'email' ? 'Emails' : 'Voice Calls',
            value: c._count.id,
            color: ch === 'whatsapp' ? '#25D366' : ch === 'instagram' ? '#E1306C' : ch === 'email' ? '#3b82f6' : '#f97316'
          };
        })
      : [
          { name: 'WhatsApp', value: 0, color: '#25D366' },
          { name: 'Instagram', value: 0, color: '#E1306C' },
          { name: 'Voice Calls', value: totalCalls, color: '#f97316' },
          { name: 'Emails', value: 0, color: '#3b82f6' }
        ];

    const hourCounts: { [hour: number]: number } = {};
    for (let h = 0; h < 24; h++) hourCounts[h] = 0;
    for (const cs of callSessions) {
      if (cs.startedAt) {
        const h = new Date(cs.startedAt).getHours();
        hourCounts[h] = (hourCounts[h] || 0) + 1;
      }
    }
    const callsPerHour = Array.from({ length: 24 }, (_, i) => ({
      hour: `${String(i).padStart(2, '0')}:00`,
      calls: hourCounts[i] || 0
    }));

    let kpis = [];
    if (type === 'sales_lead') {
      kpis = [
        { label: 'New Leads', value: String(activeLeads), change: 'Live', isPositive: true },
        { label: 'Qualified Leads', value: String(positiveLeads), change: 'Live', isPositive: true },
        { label: 'Won Deals', value: String(convertedLeads), change: 'Live', isPositive: true },
        { label: 'Total Ingested', value: String(totalLeads), change: 'On Track', isPositive: true },
        { label: 'Conversion Rate', value: `${conversionRate}%`, change: null, isPositive: true },
        { label: 'Won Deal Value', value: convertedLeads > 0 ? `$${(convertedLeads * 1250).toLocaleString()}` : '$0', change: null, isPositive: true },
      ];
    } else if (type === 'agent_performance') {
      kpis = [
        { label: 'Total Calls Handled', value: String(totalCalls), change: 'Live', isPositive: true },
        { label: 'Avg Talk Time', value: avgDurationFormatted, change: 'Optimal', isPositive: true },
        { label: 'SLA Compliance', value: totalCalls > 0 ? '96.2%' : '100%', change: null, isPositive: true },
        { label: 'Available Agents', value: String(availableAgents), change: 'Optimal', isPositive: true },
      ];
    } else if (type === 'contact_center') {
      kpis = [
        { label: 'Live Active Calls', value: String(activeCalls), change: 'Live', isPositive: true },
        { label: 'Waiting in Queue', value: String(waitingQueue), change: 'Live', isPositive: true },
        { label: 'Available Agents', value: String(availableAgents), change: 'Live', isPositive: true },
      ];
    } else {
      kpis = [
        { label: 'Total Customers', value: String(totalCustomers), change: 'Live', isPositive: true },
        { label: 'Active Leads Pool', value: String(activeLeads), change: 'Live', isPositive: true },
        { label: 'Conversion Rate', value: `${conversionRate}%`, change: null, isPositive: true },
        { label: 'Pipeline Deals', value: String(totalLeads), change: 'Live', isPositive: true },
      ];
    }

    const sourceShare = servicesCount.length > 0
      ? servicesCount.map((s: any) => ({ name: s.serviceInterest || 'General', value: s._count.id }))
      : [
          { name: 'Direct Inbound', value: totalCalls },
          { name: 'Website Forms', value: activeLeads },
        ];

    const salesFunnel = [
      { stage: 'Total Ingested', count: totalLeads },
      { stage: 'Contacted', count: activeLeads + convertedLeads },
      { stage: 'Qualified', count: positiveLeads },
      { stage: 'Converted', count: convertedLeads },
    ];

    const positiveSentimentPercent = positiveLeads > 0 ? Math.round((positiveLeads / (totalLeads || 1)) * 100) : 0;
    const negativeSentimentPercent = 0;
    const neutralSentimentPercent = Math.max(0, 100 - positiveSentimentPercent - negativeSentimentPercent);

    return {
      totalCalls,
      activeAgents: availableAgents,
      openTickets: assignedTickets,
      sentiment: {
        positive: positiveSentimentPercent,
        neutral: neutralSentimentPercent,
        negative: negativeSentimentPercent
      },
      kpis,
      charts: {
        sourceShare,
        salesFunnel,
        pipelineTrend: [
          { period: 'Week 1', count: 0 },
          { period: 'Week 2', count: 0 },
          { period: 'Week 3', count: 0 },
          { period: 'Week 4', count: totalLeads },
        ],
        revenueTrend: [
          { month: 'Jan', revenue: 0 },
          { month: 'Feb', revenue: 0 },
          { month: 'Mar', revenue: 0 },
          { month: 'Apr', revenue: convertedLeads > 0 ? convertedLeads * 1250 : 0 },
        ],
        callsPerHour,
        omnichannelShare: channelDistribution,
        agentLeaderboard: agentsList
      },
      metrics: {
        activeCalls,
        queueCalls: waitingQueue,
        totalCalls,
        totalCustomers,
        totalLeads,
        activeLeads,
        convertedLeads,
        avgDurationSec,
        avgHandleTime: avgDurationFormatted,
        slaMet: totalCalls > 0 ? '96%' : '100%',
        unreadMessages,
        assignedTickets,
        agentLeaderboard: agentsList,
        omnichannelShare: channelDistribution,
        callsPerHour
      },
      liveStats: {
        activeCalls,
        waitingQueue,
        availableAgents,
        totalCustomers,
        totalLeads,
        conversionRate,
        unreadMessages,
        assignedTickets
      }
    };
  }

  @Get('agent-dashboard')
  async getAgentDashboardData(@Req() req: any) {
    const user = req?.user;
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(now);
    const year = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
    const month = parseInt(parts.find((p) => p.type === 'month')!.value, 10) - 1;
    const day = parseInt(parts.find((p) => p.type === 'day')!.value, 10);

    const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
    const startOfToday = new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - istOffsetMs);
    const endOfToday = new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - istOffsetMs);

    let agent: any = null;
    if (user?.agentId) {
      agent = await this.prisma.agent.findUnique({ where: { id: user.agentId } });
    }
    if (!agent && (user?.userId || user?.id || user?.sub)) {
      agent = await this.prisma.agent.findFirst({
        where: { userId: user.userId || user.id || user.sub }
      });
    }
    if (!agent) {
      agent = await this.prisma.agent.findFirst({
        where: { isDeleted: false },
        orderBy: { updatedAt: 'desc' }
      });
    }

    const agentId = agent?.id;
    const agentName = agent?.name || user?.email?.split('@')[0] || 'Care Agent';
    const agentStatus = agent?.status || 'AVAILABLE';

    const defaultShiftStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
    const shiftStartTime = (agent?.lastActive && agent.lastActive >= startOfToday)
      ? agent.lastActive
      : defaultShiftStart;
    const shiftElapsedSeconds = Math.max(Math.floor((now.getTime() - shiftStartTime.getTime()) / 1000), 0);

    const [
      callsConnectedToday,
      callsMissedToday,
      unansweredCallsToday,
      failedCallsToday,
      agentCallsHandledToday,
      ticketsRaisedToday,
      ticketsResolvedToday,
      totalTicketsRaised,
      pendingTickets,
      unreadConversationsCount,
      repliedConversationsCount,
      waitingQueueCount,
      todayTransfers,
      todayLeadsByFoundation,
      todayLeadsBySource,
      todayFollowups,
      priorityLeadsRaw,
      hourlyCallsRaw,
    ] = await Promise.all([
      this.prisma.callSession.count({
        where: {
          createdAt: { gte: startOfToday, lte: endOfToday },
          status: { in: ['CONNECTED', 'ENDED', 'IN_PROGRESS'] },
          duration: { gt: 0 },
        }
      }).catch(() => 0),

      this.prisma.callSession.count({
        where: {
          createdAt: { gte: startOfToday, lte: endOfToday },
          status: 'MISSED',
        }
      }).catch(() => 0),

      this.prisma.callSession.count({
        where: {
          createdAt: { gte: startOfToday, lte: endOfToday },
          status: { in: ['UNANSWERED', 'REJECTED'] },
        }
      }).catch(() => 0),

      this.prisma.callSession.count({
        where: {
          createdAt: { gte: startOfToday, lte: endOfToday },
          status: { in: ['FAILED', 'CANCELLED'] },
        }
      }).catch(() => 0),

      agentId ? this.prisma.callParticipant.count({
        where: {
          agentId,
          joinedAt: { gte: startOfToday, lte: endOfToday },
        }
      }).catch(() => 0) : 0,

      this.prisma.ticket.count({
        where: {
          createdAt: { gte: startOfToday, lte: endOfToday },
          ...(agentId ? { agentId } : {}),
        }
      }).catch(() => 0),

      this.prisma.ticket.count({
        where: {
          updatedAt: { gte: startOfToday, lte: endOfToday },
          status: { in: ['RESOLVED', 'CLOSED'] },
          ...(agentId ? { agentId } : {}),
        }
      }).catch(() => 0),

      // Total Tickets Raised by logged-in agent (all time)
      this.prisma.ticket.count({
        where: agentId ? { agentId } : {},
      }).catch(() => 0),

      // Pending / Unresolved Tickets assigned to logged-in agent
      this.prisma.ticket.count({
        where: {
          status: { notIn: ['RESOLVED', 'CLOSED'] },
          ...(agentId ? { agentId } : {}),
        },
      }).catch(() => 0),

      this.prisma.conversation.count({
        where: {
          unreadCount: { gt: 0 },
          status: { in: ['OPEN', 'PENDING'] },
        }
      }).catch(() => 0),

      this.prisma.message.findMany({
        where: {
          createdAt: { gte: startOfToday, lte: endOfToday },
          senderType: 'AGENT',
        },
        distinct: ['conversationId'],
        select: { conversationId: true },
      }).then(res => res.length).catch(() => 0),

      this.prisma.queueItem.count({
        where: { status: 'WAITING' }
      }).catch(() => 0),

      this.prisma.callTransferAudit.findMany({
        where: { createdAt: { gte: startOfToday, lte: endOfToday } },
        include: {
          initiatingAgent: { select: { id: true, name: true, department: true } },
          destinationAgent: { select: { id: true, name: true, department: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }).catch(() => []),

      this.prisma.lead.groupBy({
        by: ['foundation'],
        where: { createdAt: { gte: startOfToday, lte: endOfToday }, isMerged: false },
        _count: { id: true },
      }).catch(() => []),

      this.prisma.lead.groupBy({
        by: ['source'],
        where: { createdAt: { gte: startOfToday, lte: endOfToday }, isMerged: false },
        _count: { id: true },
      }).catch(() => []),

      this.prisma.leadFollowup.findMany({
        where: {
          followupDate: { gte: startOfToday, lte: endOfToday },
        },
        include: {
          lead: { select: { id: true, customerName: true, phoneNumber: true, priority: true } },
          assignedAgent: { select: { id: true, name: true } },
        },
        orderBy: { followupDate: 'asc' },
        take: 10,
      }).catch(() => []),

      this.prisma.lead.findMany({
        where: {
          isMerged: false,
          status: { in: ['NEW', 'IN_PROGRESS'] },
        },
        orderBy: [
          { isAmbulanceEmergency: 'desc' },
          { priority: 'desc' },
          { createdAt: 'desc' },
        ],
        take: 15,
        include: {
          assignedAgent: { select: { id: true, name: true } },
        }
      }).catch(() => []),

      this.prisma.callSession.findMany({
        where: { createdAt: { gte: startOfToday, lte: endOfToday } },
        select: { createdAt: true, status: true, duration: true },
      }).catch(() => []),
    ]);

    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    const notRespondedCount = await this.prisma.conversation.count({
      where: {
        status: { in: ['OPEN', 'PENDING'] },
        unreadCount: { gt: 0 },
        updatedAt: { lte: fifteenMinsAgo },
      }
    }).catch(() => 0);

    const dailyTarget = 25;
    const completedWork = agentCallsHandledToday + ticketsResolvedToday;
    const targetRemaining = Math.max(dailyTarget - completedWork, 0);

    const hourlyMap: Record<number, { connected: number; missed: number; unanswered: number; failed: number }> = {};
    for (let h = 0; h < 24; h++) {
      hourlyMap[h] = { connected: 0, missed: 0, unanswered: 0, failed: 0 };
    }
    for (const c of hourlyCallsRaw) {
      const h = new Date(c.createdAt).getHours();
      if (c.status === 'CONNECTED' || c.status === 'ENDED') {
        hourlyMap[h].connected++;
      } else if (c.status === 'MISSED') {
        hourlyMap[h].missed++;
      } else if (c.status === 'UNANSWERED' || c.status === 'REJECTED') {
        hourlyMap[h].unanswered++;
      } else {
        hourlyMap[h].failed++;
      }
    }
    const callLogsVolume = Array.from({ length: 24 }, (_, i) => ({
      hour: `${String(i).padStart(2, '0')}:00`,
      connected: hourlyMap[i].connected,
      missed: hourlyMap[i].missed,
      unanswered: hourlyMap[i].unanswered,
      failed: hourlyMap[i].failed,
      total: hourlyMap[i].connected + hourlyMap[i].missed + hourlyMap[i].unanswered + hourlyMap[i].failed,
    }));

    const transfersByDept: Record<string, { total: number; completed: number; cancelled: number }> = {};
    for (const tr of todayTransfers) {
      const dept = tr.destDepartment || 'General';
      if (!transfersByDept[dept]) transfersByDept[dept] = { total: 0, completed: 0, cancelled: 0 };
      transfersByDept[dept].total++;
      if (tr.status === 'COMPLETED') transfersByDept[dept].completed++;
      if (tr.status === 'CANCELLED' || tr.status === 'FAILED') transfersByDept[dept].cancelled++;
    }

    const followupsSummary = {
      scheduled: todayFollowups.length,
      completed: todayFollowups.filter(f => f.status === 'COMPLETED').length,
      pending: todayFollowups.filter(f => f.status === 'PENDING').length,
      overdue: todayFollowups.filter(f => f.status === 'PENDING' && new Date(f.followupDate) < now).length,
      list: todayFollowups.map(f => ({
        id: f.id,
        leadName: f.lead?.customerName || 'Unknown',
        phoneNumber: f.lead?.phoneNumber || '',
        priority: f.lead?.priority || 'NORMAL',
        followupDate: f.followupDate.toISOString(),
        meetingType: f.meetingType,
        purpose: f.purpose,
        status: f.status,
        agentName: f.assignedAgent?.name || 'Assigned Agent',
      })),
    };

    const formattedPriorityLeads = priorityLeadsRaw.map(lead => ({
      id: lead.id,
      name: lead.customerName,
      phone: lead.phoneNumber,
      foundation: lead.foundation || 'UEC',
      service: lead.primaryService || lead.serviceInterest || 'General Care',
      priority: lead.isAmbulanceEmergency ? 'EMERGENCY' : lead.priority,
      isEmergency: lead.isAmbulanceEmergency,
      assignedAgent: lead.assignedAgent?.name || 'Unassigned',
      status: lead.status,
      createdAt: lead.createdAt.toISOString(),
      notes: lead.notes,
    }));

    return {
      header: {
        agentName,
        agentStatus,
        shiftStartTime: shiftStartTime.toISOString(),
        shiftDurationSeconds: shiftElapsedSeconds,
        callsHandledToday: agentCallsHandledToday,
        ticketsRaisedToday,
        ticketsResolvedToday,
      },
      kpiCards: {
        callsConnected: callsConnectedToday,
        callsMissed: callsMissedToday,
        notResponded: notRespondedCount,
        unreadEnquiries: unreadConversationsCount,
        repliedEnquiries: repliedConversationsCount,
        targetRemaining,
        dailyTarget,
        completedWork,
        totalTicketsRaised,
        pendingTickets,
      },
      analytics: {
        callLogsVolume,
        callLogsTotals: {
          connected: callsConnectedToday,
          missed: callsMissedToday,
          unanswered: unansweredCallsToday,
          failed: failedCallsToday,
          total: callsConnectedToday + callsMissedToday + unansweredCallsToday + failedCallsToday,
        },
        queueCalls: {
          waiting: waitingQueueCount,
          avgWaitTimeSec: 24,
          abandonmentRate: callsMissedToday > 0 ? `${((callsMissedToday / (callsConnectedToday + callsMissedToday || 1)) * 100).toFixed(1)}%` : '0%',
        },
        transferCalls: {
          total: todayTransfers.length,
          completed: todayTransfers.filter(t => t.status === 'COMPLETED').length,
          cancelled: todayTransfers.filter(t => t.status === 'CANCELLED').length,
          byDepartment: Object.entries(transfersByDept).map(([dept, data]) => ({ department: dept, ...data })),
          recent: todayTransfers.slice(0, 5).map(t => ({
            id: t.id,
            from: t.initiatingAgent?.name || 'Agent',
            to: t.destinationAgent?.name || 'Queue',
            dept: t.destDepartment,
            status: t.status,
            time: t.createdAt.toISOString(),
          })),
        },
        newLeadsToday: {
          total: todayLeadsByFoundation.reduce((acc, curr) => acc + curr._count.id, 0),
          byFoundation: todayLeadsByFoundation.map(f => ({ name: f.foundation || 'General', count: f._count.id })),
          bySource: todayLeadsBySource.map(s => ({ source: s.source || 'Website', count: s._count.id })),
        },
        todayFollowups: followupsSummary,
        priorityLeads: formattedPriorityLeads,
      }
    };
  }
}
