import { Injectable, Logger, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DuplicateMatchOutcome } from '@prisma/client';

export interface DuplicateCheckDto {
  phoneNumber?: string;
  email?: string;
  customerName?: string;
  excludeLeadId?: string;
}

export interface MergeLeadsDto {
  primaryLeadId: string;
  duplicateLeadId: string;
  reason?: string;
  fieldOverrides?: Record<string, any>;
}

@Injectable()
export class DeduplicationService {
  private readonly logger = new Logger(DeduplicationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Normalize phone number to consistent E.164 standard where possible
   */
  normalizePhoneNumber(phone: string): string {
    if (!phone) return '';
    const cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
    if (!cleaned) return '';

    // Handle leading '+'
    if (cleaned.startsWith('+')) {
      return cleaned;
    }

    // Handle Indian 10-digit number without country code
    if (/^\d{10}$/.test(cleaned)) {
      return `+91${cleaned}`;
    }

    // Handle Indian number with 91 prefix without '+'
    if (/^91\d{10}$/.test(cleaned)) {
      return `+${cleaned}`;
    }

    // Handle leading zero: 09876543210 -> +919876543210
    if (/^0\d{10}$/.test(cleaned)) {
      return `+91${cleaned.substring(1)}`;
    }

    return `+${cleaned}`;
  }

  /**
   * Normalize email address
   */
  normalizeEmail(email: string): string {
    if (!email) return '';
    return email.trim().toLowerCase();
  }

  /**
   * Normalize name string for fuzzy matching comparison
   */
  normalizeName(name: string): string {
    if (!name) return '';
    return name
      .toLowerCase()
      .trim()
      .replace(/^(mr|mrs|ms|dr|prof)\.?\s+/i, '')
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ');
  }

  /**
   * Layered duplicate check for new or existing lead
   */
  async checkDuplicate(dto: DuplicateCheckDto): Promise<{
    outcome: DuplicateMatchOutcome;
    confidenceScore: number;
    matchingFields: string[];
    matches: any[];
    recommendation: string;
  }> {
    const rawPhone = dto.phoneNumber || '';
    const rawEmail = dto.email || '';
    const rawName = dto.customerName || '';

    const normPhone = this.normalizePhoneNumber(rawPhone);
    const normEmail = this.normalizeEmail(rawEmail);
    const normName = this.normalizeName(rawName);

    if (!normPhone && !normEmail && !normName) {
      return {
        outcome: DuplicateMatchOutcome.NO_DUPLICATE,
        confidenceScore: 0,
        matchingFields: [],
        matches: [],
        recommendation: 'Insufficient data for duplicate analysis',
      };
    }

    // Build query conditions
    const orConditions: any[] = [];
    if (normPhone) {
      // Check normalized phone, raw phone, or phone without +
      const strippedPhone = normPhone.replace(/^\+/, '');
      orConditions.push({ phoneNumber: normPhone });
      orConditions.push({ phoneNumber: rawPhone });
      orConditions.push({ phoneNumber: { contains: strippedPhone.slice(-10) } });
    }
    if (normEmail) {
      orConditions.push({ email: { equals: normEmail, mode: 'insensitive' } });
    }
    if (normName && normName.length >= 3) {
      orConditions.push({ customerName: { contains: rawName, mode: 'insensitive' } });
    }

    const where: any = {
      isMerged: false,
      OR: orConditions,
    };

    if (dto.excludeLeadId) {
      where.id = { not: dto.excludeLeadId };
    }

    const candidates = await this.prisma.lead.findMany({
      where,
      take: 10,
      include: {
        assignedAgent: { select: { id: true, name: true } },
        _count: {
          select: {
            callSessions: true,
            followups: true,
            conversationsLinked: true,
          }
        }
      }
    });

    if (candidates.length === 0) {
      return {
        outcome: DuplicateMatchOutcome.NO_DUPLICATE,
        confidenceScore: 0,
        matchingFields: [],
        matches: [],
        recommendation: 'No matching records found. Safe to proceed.',
      };
    }

    // Score candidates
    let highestScore = 0;
    let primaryMatchingFields: string[] = [];

    const scoredMatches = candidates.map(c => {
      const cNormPhone = this.normalizePhoneNumber(c.phoneNumber);
      const cNormEmail = this.normalizeEmail(c.email || '');
      const cNormName = this.normalizeName(c.customerName);

      const matchedFields: string[] = [];
      let score = 0;

      // 1. Phone match (highest confidence)
      if (normPhone && cNormPhone) {
        if (normPhone === cNormPhone || normPhone.slice(-10) === cNormPhone.slice(-10)) {
          matchedFields.push('phoneNumber');
          score += 65;
        }
      }

      // 2. Email match
      if (normEmail && cNormEmail && normEmail === cNormEmail) {
        matchedFields.push('email');
        score += 30;
      }

      // 3. Name match
      if (normName && cNormName) {
        if (normName === cNormName) {
          matchedFields.push('customerName');
          score += 15;
        } else if (normName.includes(cNormName) || cNormName.includes(normName)) {
          matchedFields.push('customerName (partial)');
          score += 10;
        }
      }

      const cappedScore = Math.min(score, 100);
      if (cappedScore > highestScore) {
        highestScore = cappedScore;
        primaryMatchingFields = matchedFields;
      }

      return {
        lead: c,
        score: cappedScore,
        matchedFields,
      };
    });

    // Determine outcome
    let outcome: DuplicateMatchOutcome;
    let recommendation: string;

    if (highestScore >= 90) {
      outcome = DuplicateMatchOutcome.HIGH_CONFIDENCE;
      recommendation = 'Strong duplicate detected (exact phone/email). Merging or associating is recommended.';
    } else if (highestScore >= 70) {
      outcome = DuplicateMatchOutcome.POSSIBLE_DUPLICATE;
      recommendation = 'Possible duplicate detected. Review matched details before creating new record.';
    } else if (highestScore >= 40) {
      outcome = DuplicateMatchOutcome.POSSIBLE_DUPLICATE;
      recommendation = 'Name resemblance found. Do not merge automatically without verifying contact info.';
    } else {
      outcome = DuplicateMatchOutcome.NO_DUPLICATE;
      recommendation = 'Low match score. Proceeding with caution.';
    }

    return {
      outcome,
      confidenceScore: highestScore,
      matchingFields: primaryMatchingFields,
      matches: scoredMatches.sort((a, b) => b.score - a.score),
      recommendation,
    };
  }

  /**
   * Scan existing active leads to find duplicate pairs and record them for review
   */
  async scanForDuplicates(limit = 100): Promise<{ scanned: number; duplicatesFound: number }> {
    this.logger.log(`Scanning leads for duplicates (batch size: ${limit})...`);
    const leads = await this.prisma.lead.findMany({
      where: { isMerged: false },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        customerName: true,
        phoneNumber: true,
        email: true,
      }
    });

    let duplicatesFound = 0;

    for (const lead of leads) {
      const check = await this.checkDuplicate({
        phoneNumber: lead.phoneNumber,
        email: lead.email || undefined,
        customerName: lead.customerName,
        excludeLeadId: lead.id,
      });

      if (check.confidenceScore >= 70 && check.matches.length > 0) {
        const topMatch = check.matches[0].lead;

        // Ensure we don't insert duplicate review record if already exists
        const existingReview = await this.prisma.leadDuplicateReview.findFirst({
          where: {
            OR: [
              { primaryLeadId: lead.id, duplicateLeadId: topMatch.id },
              { primaryLeadId: topMatch.id, duplicateLeadId: lead.id },
            ]
          }
        });

        if (!existingReview) {
          await this.prisma.leadDuplicateReview.create({
            data: {
              primaryLeadId: topMatch.id, // older or higher score lead as primary
              duplicateLeadId: lead.id,
              matchingFields: check.matchingFields,
              confidenceScore: check.confidenceScore,
              status: check.outcome,
            }
          });
          duplicatesFound++;
        }
      }
    }

    return { scanned: leads.length, duplicatesFound };
  }

  /**
   * Get list of duplicate review pairs
   */
  async getDuplicateReviews(query: any = {}) {
    const status = query.status;
    const where: any = {};
    if (status) {
      where.status = status;
    } else {
      where.status = { in: ['POSSIBLE_DUPLICATE', 'HIGH_CONFIDENCE', 'CONFIRMED_DUPLICATE'] };
    }

    const reviews = await this.prisma.leadDuplicateReview.findMany({
      where,
      orderBy: { confidenceScore: 'desc' },
      take: 50,
      include: {
        primaryLead: {
          include: {
            assignedAgent: { select: { id: true, name: true } },
            _count: {
              select: {
                callSessions: true,
                followups: true,
                conversationsLinked: true,
              }
            }
          }
        },
        duplicateLead: {
          include: {
            assignedAgent: { select: { id: true, name: true } },
            _count: {
              select: {
                callSessions: true,
                followups: true,
                conversationsLinked: true,
              }
            }
          }
        },
        reviewedBy: { select: { id: true, email: true } },
      }
    });

    return reviews.map(r => ({
      id: r.id,
      confidenceScore: r.confidenceScore,
      matchingFields: r.matchingFields,
      status: r.status,
      resolutionNotes: r.resolutionNotes,
      createdAt: r.createdAt,
      primaryLead: {
        id: r.primaryLead.id,
        name: r.primaryLead.customerName,
        phone: r.primaryLead.phoneNumber,
        email: r.primaryLead.email,
        source: r.primaryLead.source,
        foundation: r.primaryLead.foundation,
        primaryService: r.primaryLead.primaryService,
        status: r.primaryLead.status,
        priority: r.primaryLead.priority,
        city: r.primaryLead.city,
        assignedAgent: r.primaryLead.assignedAgent?.name || 'Unassigned',
        callCount: r.primaryLead._count.callSessions,
        followupCount: r.primaryLead._count.followups,
        conversationCount: r.primaryLead._count.conversationsLinked,
        createdAt: r.primaryLead.createdAt,
      },
      duplicateLead: {
        id: r.duplicateLead.id,
        name: r.duplicateLead.customerName,
        phone: r.duplicateLead.phoneNumber,
        email: r.duplicateLead.email,
        source: r.duplicateLead.source,
        foundation: r.duplicateLead.foundation,
        primaryService: r.duplicateLead.primaryService,
        status: r.duplicateLead.status,
        priority: r.duplicateLead.priority,
        city: r.duplicateLead.city,
        assignedAgent: r.duplicateLead.assignedAgent?.name || 'Unassigned',
        callCount: r.duplicateLead._count.callSessions,
        followupCount: r.duplicateLead._count.followups,
        conversationCount: r.duplicateLead._count.conversationsLinked,
        createdAt: r.duplicateLead.createdAt,
      }
    }));
  }

  /**
   * Mark duplicate review as separate people (REJECTED) or confirm duplicate
   */
  async resolveReview(reviewId: string, status: DuplicateMatchOutcome, notes?: string, user?: any) {
    const review = await this.prisma.leadDuplicateReview.findUnique({
      where: { id: reviewId },
    });
    if (!review) {
      throw new NotFoundException(`Review record ${reviewId} not found`);
    }

    return await this.prisma.leadDuplicateReview.update({
      where: { id: reviewId },
      data: {
        status,
        resolutionNotes: notes,
        reviewedById: user?.userId || user?.id || user?.sub,
      }
    });
  }

  /**
   * Safe Lead Merge Transaction
   */
  async mergeLeads(dto: MergeLeadsDto, user?: any) {
    const { primaryLeadId, duplicateLeadId, reason, fieldOverrides } = dto;

    if (primaryLeadId === duplicateLeadId) {
      throw new BadRequestException('Primary lead and duplicate lead cannot be the same record');
    }

    const userId = user?.userId || user?.id || user?.sub;
    if (!userId) {
      throw new BadRequestException('Authenticated user ID required for merge audit trail');
    }

    this.logger.log(`[LEAD-MERGE] Starting transactional merge: duplicate=${duplicateLeadId} -> primary=${primaryLeadId}`);

    // Execute within database transaction
    return await this.prisma.$transaction(async (tx) => {
      // 1. Fetch both leads
      const primaryLead = await tx.lead.findUnique({
        where: { id: primaryLeadId },
      });
      if (!primaryLead) {
        throw new NotFoundException(`Primary lead not found: ${primaryLeadId}`);
      }
      if (primaryLead.isMerged) {
        throw new ConflictException(`Primary lead is already merged into ${primaryLead.mergedIntoLeadId}`);
      }

      const duplicateLead = await tx.lead.findUnique({
        where: { id: duplicateLeadId },
      });
      if (!duplicateLead) {
        throw new NotFoundException(`Duplicate lead not found: ${duplicateLeadId}`);
      }
      if (duplicateLead.isMerged) {
        throw new ConflictException(`Duplicate lead is already merged into ${duplicateLead.mergedIntoLeadId}`);
      }

      // 2. Capture complete pre-merge snapshot of duplicate lead for rollback/recovery
      const duplicateSnapshot = JSON.parse(JSON.stringify(duplicateLead));

      // 3. Create LeadMergeAudit record
      const mergeAudit = await tx.leadMergeAudit.create({
        data: {
          primaryLeadId: primaryLead.id,
          mergedLeadId: duplicateLead.id,
          mergedLeadSnapshot: duplicateSnapshot,
          conflictResolutions: fieldOverrides ? (fieldOverrides as any) : undefined,
          mergedById: userId,
          reason: reason || 'Agent/Admin confirmed duplicate merge',
        }
      });

      // 4. Reassign all related child records from duplicate lead to primary lead
      await tx.callSession.updateMany({
        where: { leadId: duplicateLead.id },
        data: { leadId: primaryLead.id },
      });

      await tx.leadFollowup.updateMany({
        where: { leadId: duplicateLead.id },
        data: { leadId: primaryLead.id },
      });

      await tx.appointment.updateMany({
        where: { leadId: duplicateLead.id },
        data: { leadId: primaryLead.id },
      });

      await tx.conversation.updateMany({
        where: { leadId: duplicateLead.id },
        data: { leadId: primaryLead.id },
      });

      await tx.leadConversionLog.updateMany({
        where: { leadId: duplicateLead.id },
        data: { leadId: primaryLead.id },
      });

      await tx.leadNotification.updateMany({
        where: { leadId: duplicateLead.id },
        data: { leadId: primaryLead.id },
      });

      await tx.websiteLeadSubmission.updateMany({
        where: { leadId: duplicateLead.id },
        data: { leadId: primaryLead.id },
      });

      await tx.sopExecution.updateMany({
        where: { leadId: duplicateLead.id },
        data: { leadId: primaryLead.id },
      });

      await tx.leadTransferAudit.updateMany({
        where: { leadId: duplicateLead.id },
        data: { leadId: primaryLead.id },
      });

      // 5. Backfill non-empty missing fields into primary lead
      const updateData: any = {};

      if (!primaryLead.email && duplicateLead.email) {
        updateData.email = duplicateLead.email;
      }
      if (!primaryLead.city && duplicateLead.city) {
        updateData.city = duplicateLead.city;
      }
      if (!primaryLead.patientName && duplicateLead.patientName) {
        updateData.patientName = duplicateLead.patientName;
      }
      if (!primaryLead.patientConditions && duplicateLead.patientConditions) {
        updateData.patientConditions = duplicateLead.patientConditions;
      }
      if (!primaryLead.serviceAddress && duplicateLead.serviceAddress) {
        updateData.serviceAddress = duplicateLead.serviceAddress;
      }
      if (!primaryLead.foundation && duplicateLead.foundation) {
        updateData.foundation = duplicateLead.foundation;
      }
      if (!primaryLead.primaryService && duplicateLead.primaryService) {
        updateData.primaryService = duplicateLead.primaryService;
      }

      // Append notes
      const mergeNoteEntry = `\n[Merged record ${duplicateLead.id.slice(0, 8)} on ${new Date().toISOString()}]: ${duplicateLead.notes || 'No notes'}`;
      updateData.notes = (primaryLead.notes || '') + mergeNoteEntry;

      // Apply any manual field overrides specified by user
      if (fieldOverrides && typeof fieldOverrides === 'object') {
        Object.assign(updateData, fieldOverrides);
      }

      const updatedPrimary = await tx.lead.update({
        where: { id: primaryLead.id },
        data: updateData,
      });

      // 6. Soft-merge duplicate lead
      // To prevent unique constraint violation on phoneNumber, append merged suffix if needed
      const mergedPhone = `${duplicateLead.phoneNumber}#merged_${duplicateLead.id.slice(0, 6)}`;
      await tx.lead.update({
        where: { id: duplicateLead.id },
        data: {
          isMerged: true,
          mergedIntoLeadId: primaryLead.id,
          status: 'CLOSED',
          phoneNumber: mergedPhone,
        }
      });

      // 7. Mark duplicate reviews as MERGED
      await tx.leadDuplicateReview.updateMany({
        where: {
          OR: [
            { primaryLeadId: primaryLead.id, duplicateLeadId: duplicateLead.id },
            { primaryLeadId: duplicateLead.id, duplicateLeadId: primaryLead.id },
          ]
        },
        data: {
          status: DuplicateMatchOutcome.MERGED,
          resolutionNotes: `Merged into ${primaryLead.id}`,
        }
      });

      this.logger.log(`[LEAD-MERGE] Completed transactional merge: auditId=${mergeAudit.id}`);

      return {
        success: true,
        mergeAuditId: mergeAudit.id,
        primaryLead: updatedPrimary,
        mergedDuplicateId: duplicateLead.id,
      };
    });
  }
}
