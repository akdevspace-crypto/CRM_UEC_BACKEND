import { Controller, Get, Logger, Req } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller(['api/v1/analytics', 'api/v1/dashboard', 'dashboard'])
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(private readonly prisma: PrismaService) {}

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
}
