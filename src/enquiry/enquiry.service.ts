import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Priority, LeadPriority, EnquiryCategory } from '@prisma/client';
import { INITIAL_FOUNDATIONS, CARE_CONFIG } from './enquiry-catalog.data';
import {
  UpdateEnquiryClassificationDto,
  CreateLeadFromEnquiryDto,
  SaveCallIntakeDto,
  SaveLiveNotesDto,
  OverrideEmergencyPriorityDto,
  CreateCatalogItemDto,
} from './dto/enquiry.dto';

@Injectable()
export class EnquiryService {
  private readonly logger = new Logger(EnquiryService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ==========================================
  // SERVICE CATALOG MANAGEMENT
  // ==========================================
  async getCatalog(foundationKey?: string) {
    let items = await this.prisma.serviceCatalogItem.findMany({
      where: {
        isActive: true,
        ...(foundationKey ? { foundationKey } : {}),
      },
      orderBy: [{ foundationKey: 'asc' }, { sortOrder: 'asc' }],
    });

    if (items.length === 0) {
      this.logger.log('Service catalog is empty. Auto-seeding initial catalog foundations...');
      await this.seedDefaultCatalog();
      items = await this.prisma.serviceCatalogItem.findMany({
        where: {
          isActive: true,
          ...(foundationKey ? { foundationKey } : {}),
        },
        orderBy: [{ foundationKey: 'asc' }, { sortOrder: 'asc' }],
      });
    }

    // Group items by foundation
    const foundationsMap = new Map<string, { key: string; name: string; category: string; services: any[] }>();
    for (const f of INITIAL_FOUNDATIONS) {
      foundationsMap.set(f.key, { key: f.key, name: f.name, category: f.category, services: [] });
    }

    for (const item of items) {
      if (!foundationsMap.has(item.foundationKey)) {
        foundationsMap.set(item.foundationKey, {
          key: item.foundationKey,
          name: item.foundationName,
          category: item.category,
          services: [],
        });
      }
      foundationsMap.get(item.foundationKey)!.services.push(item);
    }

    return {
      foundations: Array.from(foundationsMap.values()),
      items,
      config: CARE_CONFIG,
    };
  }

  async seedDefaultCatalog() {
    for (const f of INITIAL_FOUNDATIONS) {
      let sort = 10;
      for (const s of f.services) {
        const existing = await this.prisma.serviceCatalogItem.findFirst({
          where: {
            foundationKey: f.key,
            code: s.code,
          },
        });
        if (!existing) {
          await this.prisma.serviceCatalogItem.create({
            data: {
              foundationKey: f.key,
              foundationName: f.name,
              category: f.category,
              name: s.name,
              code: s.code,
              description: s.description || null,
              subServices: s.subServices || [],
              isEmergency: !!s.isEmergency,
              sortOrder: sort,
              isActive: true,
            },
          });
        }
        sort += 10;
      }
    }
    this.logger.log('Successfully validated and seeded default service catalog');
  }

  async createCatalogItem(dto: CreateCatalogItemDto, user: any) {
    return await this.prisma.serviceCatalogItem.create({
      data: {
        foundationKey: dto.foundationKey,
        foundationName: dto.foundationName,
        category: dto.category,
        name: dto.name,
        code: dto.code || null,
        description: dto.description || null,
        subServices: dto.subServices || [],
        isEmergency: !!dto.isEmergency,
        sortOrder: dto.sortOrder || 0,
        isActive: true,
      },
    });
  }

  async updateCatalogItem(id: string, dto: Partial<CreateCatalogItemDto>, user: any) {
    const item = await this.prisma.serviceCatalogItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Catalog item not found');

    return await this.prisma.serviceCatalogItem.update({
      where: { id },
      data: {
        ...(dto.foundationKey ? { foundationKey: dto.foundationKey } : {}),
        ...(dto.foundationName ? { foundationName: dto.foundationName } : {}),
        ...(dto.category ? { category: dto.category } : {}),
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.subServices !== undefined ? { subServices: dto.subServices } : {}),
        ...(dto.isEmergency !== undefined ? { isEmergency: dto.isEmergency } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  async deleteCatalogItem(id: string, user: any) {
    const item = await this.prisma.serviceCatalogItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Catalog item not found');

    await this.prisma.serviceCatalogItem.update({
      where: { id },
      data: { isActive: false },
    });
    return { success: true };
  }

  // ==========================================
  // INTELLIGENT OMNICHANNEL CONVERSATION CLASSIFICATION
  // ==========================================
  async classifyConversation(conversationId: string, customText?: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        customer: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');

    // Aggregate text
    let textToAnalyze = customText || '';
    if (!textToAnalyze && conversation.messages.length > 0) {
      textToAnalyze = conversation.messages.map(m => m.content).join(' ');
    }
    const lower = textToAnalyze.toLowerCase();

    // 1. Foundation detection
    let foundation = conversation.foundation || 'UEC';
    let foundationConfidence = 0.5;
    if (lower.includes('ambulance') || lower.includes('108') || lower.includes('icu on wheels') || lower.includes('emergency cardiac')) {
      foundation = 'AMBULANCE';
      foundationConfidence = 0.95;
    } else if (lower.includes('a care') || lower.includes('anbu sri') || lower.includes('doctor at home') || lower.includes('baby care') || lower.includes('wound care')) {
      foundation = 'A_CARE';
      foundationConfidence = 0.9;
    } else if (lower.includes('thatha patti') || lower.includes('thathapatti')) {
      foundation = 'THATHA_PATTI';
      foundationConfidence = 0.95;
    } else if (lower.includes('zencura')) {
      foundation = 'ZENCURA';
      foundationConfidence = 0.95;
    } else if (lower.includes('uhc') || lower.includes('universal home care')) {
      foundation = 'UHC';
      foundationConfidence = 0.9;
    } else if (lower.includes('elder care') || lower.includes('assisted living') || lower.includes('dementia') || lower.includes('bedridden')) {
      foundation = 'UEC';
      foundationConfidence = 0.85;
    }

    // 2. Enquiry Category detection
    let enquiryCategory: EnquiryCategory = EnquiryCategory.SERVICE_ENQUIRY;
    if (lower.includes('job') || lower.includes('vacancy') || lower.includes('hiring') || lower.includes('career') || lower.includes('resume') || lower.includes('apply for')) {
      enquiryCategory = EnquiryCategory.JOB_ENQUIRY;
    } else if (lower.includes('volunteer') || lower.includes('ngo') || lower.includes('social work') || lower.includes('spend time with elders')) {
      enquiryCategory = EnquiryCategory.VOLUNTEER_ENQUIRY;
    } else if (lower.includes('donate') || lower.includes('donation') || lower.includes('sponsor') || lower.includes('contribute funds')) {
      enquiryCategory = EnquiryCategory.DONOR_ENQUIRY;
    } else if (lower.includes('complaint') || lower.includes('bad service') || lower.includes('unsatisfied') || lower.includes('issue with staff')) {
      enquiryCategory = EnquiryCategory.COMPLAINT_OR_SUPPORT;
    } else if (lower.includes('timing') || lower.includes('location') || lower.includes('address') || lower.includes('general info')) {
      enquiryCategory = EnquiryCategory.GENERAL_ENQUIRY;
    }

    // 3. Primary & Subservices detection
    let primaryService = conversation.primaryService || '';
    let subServices: string[] = conversation.subServices || [];
    let isEmergency = false;

    if (foundation === 'AMBULANCE' || lower.includes('ambulance') || lower.includes('emergency')) {
      primaryService = 'Ambulance Services';
      isEmergency = true;
      if (lower.includes('icu') || lower.includes('ventilator')) {
        primaryService = 'Critical Care Ambulance (ICU on Wheels)';
        subServices = ['Ventilator Transport'];
      } else {
        primaryService = 'Emergency Ambulance Service';
        subServices = ['Emergency ALS Dispatch'];
      }
    } else if (foundation === 'A_CARE') {
      if (lower.includes('doctor')) {
        primaryService = 'Doctor at Home';
        subServices = ['General Physician Visit'];
      } else if (lower.includes('physio')) {
        primaryService = 'Physiotherapy at Home';
        subServices = ['Geriatric Mobility'];
      } else if (lower.includes('icu') || lower.includes('ryle')) {
        primaryService = 'ICU Setup & Ryle\'s Tube Feeding at Home';
        subServices = ['Ryle\'s Tube Insertion & Feeding'];
      } else if (lower.includes('wound') || lower.includes('bed sore')) {
        primaryService = 'Wound Care at Home';
        subServices = ['Diabetic Foot Ulcer Care'];
      } else if (lower.includes('nurse') || lower.includes('nursing')) {
        primaryService = 'Nursing Care at Home';
        subServices = ['Vitals Check & Injections'];
      } else {
        primaryService = 'Elder Care at Home';
        subServices = ['Bedside Attendant'];
      }
    } else if (foundation === 'UEC') {
      if (lower.includes('dementia') || lower.includes('alzheimer')) {
        primaryService = 'Dementia / Alzheimer\'s Care';
        subServices = ['Memory Care Unit'];
      } else if (lower.includes('palliative') || lower.includes('cancer') || lower.includes('terminal')) {
        primaryService = 'Palliative Care';
        subServices = ['Pain & Symptom Relief'];
      } else if (lower.includes('bedridden') || lower.includes('paralysis')) {
        primaryService = 'Bedridden Patient Care';
        subServices = ['Position Changing / Q2H Turning', 'Bed Bath & Grooming'];
      } else if (lower.includes('bed sore') || lower.includes('pressure injury')) {
        primaryService = 'Bed Sore / Pressure Injury Care';
        subServices = ['Debridement & Advanced Dressing'];
      } else if (lower.includes('post op') || lower.includes('surgery') || lower.includes('fracture')) {
        primaryService = 'Post-operative Care';
        subServices = ['Post-Op Monitoring'];
      } else {
        primaryService = 'Assisted Living';
        subServices = ['Daily Living Assistance'];
      }
    }

    // 4. Care Duration & Schedule
    let careDurationCategory = 'SHORT_TERM';
    let careDuration = '1 month';
    let careSchedule = '12-hour care (Day shift: 8 AM - 8 PM)';
    let engagementType = 'Regular Daily Care';

    if (lower.includes('day care') || lower.includes('day scholar')) {
      careDurationCategory = 'DAY_CARE';
      careDuration = '1 day';
      careSchedule = 'Daytime schedule';
      engagementType = 'Day Care / Day Scholar';
    } else if (lower.includes('residential') || lower.includes('permanent stay') || lower.includes('living in')) {
      careDurationCategory = 'LONG_TERM';
      careDuration = '6 months';
      careSchedule = '24-hour care (Full-day live-in)';
      engagementType = 'Residential Care';
    } else if (lower.includes('24 hour') || lower.includes('24 hr') || lower.includes('full day')) {
      careSchedule = '24-hour care (Full-day live-in)';
    }

    // 5. Patient info extraction
    let patientName: string | undefined = undefined;
    let patientAge: number | undefined = undefined;
    const nameMatch = textToAnalyze.match(/(?:patient|elder|father|mother|name is|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
    if (nameMatch && nameMatch[1]) {
      patientName = nameMatch[1].trim();
    }
    const ageMatch = textToAnalyze.match(/(\d{2})\s*(?:years?|yrs?|age|old)/i);
    if (ageMatch && ageMatch[1]) {
      const ageNum = parseInt(ageMatch[1], 10);
      if (ageNum >= 1 && ageNum <= 120) patientAge = ageNum;
    }

    // 6. Missing Info checklist
    const missingInfo: string[] = [];
    if (!patientName) missingInfo.push('Patient / Elder Name');
    if (!patientAge) missingInfo.push('Patient Age');
    if (!conversation.customer?.phone) missingInfo.push('Contact Phone Number');
    if (primaryService.includes('Home') || foundation === 'UHC' || foundation === 'A_CARE') {
      missingInfo.push('Home Service Address & City');
    }
    if (isEmergency) {
      missingInfo.push('Ambulance Pickup Location & Destination');
    }

    // Confidence
    const confidence = isEmergency ? 0.98 : (textToAnalyze.length > 50 && primaryService ? 0.88 : 0.65);
    const suggestedPriority: Priority = isEmergency ? Priority.EMERGENCY : (primaryService.includes('Palliative') ? Priority.HIGH : Priority.NORMAL);

    return {
      conversationId,
      foundation,
      enquiryCategory,
      primaryService,
      subServices,
      engagementType,
      careDurationCategory,
      careDuration,
      careSchedule,
      patientName,
      patientAge,
      priority: suggestedPriority,
      isEmergency,
      confidence,
      needsReview: confidence < 0.8,
      missingInfo,
    };
  }

  // ==========================================
  // UPDATE CONVERSATION ENQUIRY CLASSIFICATION
  // ==========================================
  async updateConversationClassification(conversationId: string, dto: UpdateEnquiryClassificationDto, user: any) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { lead: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    // Rule: Ambulance Services MUST enforce EMERGENCY priority
    let finalPriority: Priority = dto.priority || conversation.priority;
    const isAmbulance =
      dto.foundation === 'AMBULANCE' ||
      dto.primaryService?.toLowerCase().includes('ambulance') ||
      dto.subServices?.some(s => s.toLowerCase().includes('ambulance'));

    if (isAmbulance) {
      finalPriority = Priority.EMERGENCY;
    }

    // If downgrading from EMERGENCY, require override reason & authorized role
    if (conversation.priority === Priority.EMERGENCY && finalPriority !== Priority.EMERGENCY && !isAmbulance) {
      const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER'].includes(user.role);
      if (!isElevated) {
        throw new ForbiddenException('Only Supervisors and Administrators can downgrade an EMERGENCY enquiry priority.');
      }
      if (!dto.emergencyOverrideReason) {
        throw new BadRequestException('A mandatory reason is required to downgrade an EMERGENCY enquiry.');
      }

      await this.prisma.emergencyOverrideAudit.create({
        data: {
          conversationId,
          leadId: conversation.leadId || null,
          previousPriority: Priority.EMERGENCY,
          newPriority: finalPriority,
          overrideReason: dto.emergencyOverrideReason,
          overriddenById: user?.id || user?.userId || 'unknown-user',
          overriddenByRole: user?.role || 'AGENT',
        },
      });
    }

    // Update conversation record
    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        ...(dto.foundation ? { foundation: dto.foundation } : {}),
        ...(dto.enquiryCategory ? { enquiryCategory: dto.enquiryCategory } : {}),
        ...(dto.primaryService ? { primaryService: dto.primaryService } : {}),
        ...(dto.subServices ? { subServices: dto.subServices } : {}),
        priority: finalPriority,
        classificationConfidence: dto.classificationConfidence ?? 1.0,
        isClassificationConfirmed: dto.isClassificationConfirmed ?? true,
        ...(dto.missingInfo ? { missingInfo: dto.missingInfo } : {}),
        intakeMetadata: {
          ...((conversation.intakeMetadata as any) || {}),
          patientName: dto.patientName,
          patientAge: dto.patientAge,
          patientConditions: dto.patientConditions,
          patientMobility: dto.patientMobility,
          engagementType: dto.engagementType,
          careDurationCategory: dto.careDurationCategory,
          careDuration: dto.careDuration,
          careSchedule: dto.careSchedule,
          serviceAddress: dto.serviceAddress,
          cityDistrict: dto.cityDistrict,
          postalCode: dto.postalCode,
          pickupLocation: dto.pickupLocation,
          destinationLocation: dto.destinationLocation,
          notes: dto.notes,
          updatedAt: new Date().toISOString(),
          updatedBy: user?.name || user?.email || 'Agent',
        },
      },
    });

    // If linked to a lead, propagate classification to the Lead
    if (conversation.leadId) {
      await this.prisma.lead.update({
        where: { id: conversation.leadId },
        data: {
          ...(dto.foundation ? { foundation: dto.foundation } : {}),
          ...(dto.enquiryCategory ? { enquiryCategory: dto.enquiryCategory } : {}),
          ...(dto.primaryService ? { primaryService: dto.primaryService } : {}),
          ...(dto.subServices ? { subServices: dto.subServices } : {}),
          ...(dto.patientName ? { patientName: dto.patientName } : {}),
          ...(dto.patientAge !== undefined ? { patientAge: dto.patientAge } : {}),
          ...(dto.patientConditions ? { patientConditions: dto.patientConditions } : {}),
          ...(dto.patientMobility ? { patientMobility: dto.patientMobility } : {}),
          ...(dto.engagementType ? { engagementType: dto.engagementType } : {}),
          ...(dto.careDurationCategory ? { careDurationCategory: dto.careDurationCategory } : {}),
          ...(dto.careDuration ? { careDuration: dto.careDuration } : {}),
          ...(dto.careSchedule ? { careSchedule: dto.careSchedule } : {}),
          ...(dto.serviceAddress ? { serviceAddress: dto.serviceAddress } : {}),
          ...(dto.cityDistrict ? { cityDistrict: dto.cityDistrict } : {}),
          ...(dto.postalCode ? { postalCode: dto.postalCode } : {}),
          ...(dto.pickupLocation ? { pickupLocation: dto.pickupLocation } : {}),
          ...(dto.destinationLocation ? { destinationLocation: dto.destinationLocation } : {}),
          isAmbulanceEmergency: isAmbulance,
          priority: isAmbulance ? LeadPriority.EMERGENCY : (finalPriority === Priority.EMERGENCY ? LeadPriority.EMERGENCY : (finalPriority === Priority.HIGH ? LeadPriority.HIGH : LeadPriority.NORMAL)),
        },
      });
    }

    return updated;
  }

  // ==========================================
  // CREATE / SYNC LEAD FROM OMNICHANNEL CONVERSATION
  // ==========================================
  async createOrSyncLead(conversationId: string, dto: CreateLeadFromEnquiryDto, user: any) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { customer: true, lead: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    const phone = dto.phone || conversation.customer?.phone || null;
    const name = dto.name || conversation.customer?.name || 'Omnichannel Contact';
    const email = dto.email || conversation.customer?.email || null;

    // Check if Lead already exists for this conversation
    let lead = conversation.lead;

    // If not, check if a lead with same phone already exists in the system to prevent duplicates
    if (!lead && phone) {
      lead = await this.prisma.lead.findFirst({
        where: { phoneNumber: { contains: phone.slice(-10) } },
        orderBy: { createdAt: 'desc' },
      });
    }

    const isAmbulance =
      dto.foundation === 'AMBULANCE' ||
      dto.primaryService?.toLowerCase().includes('ambulance') ||
      dto.subServices?.some(s => s.toLowerCase().includes('ambulance'));

    const leadPriority: LeadPriority = isAmbulance
      ? LeadPriority.EMERGENCY
      : dto.priority === Priority.EMERGENCY
      ? LeadPriority.EMERGENCY
      : dto.priority === Priority.HIGH
      ? LeadPriority.HIGH
      : LeadPriority.NORMAL;

    if (lead) {
      // Update existing lead
      lead = await this.prisma.lead.update({
        where: { id: lead.id },
        data: {
          customerName: name || lead.customerName,
          phoneNumber: phone || lead.phoneNumber,
          email: email || lead.email,
          serviceInterest: dto.primaryService || lead.serviceInterest || conversation.primaryService,
          foundation: dto.foundation || lead.foundation || conversation.foundation,
          enquiryCategory: dto.enquiryCategory || lead.enquiryCategory || conversation.enquiryCategory,
          primaryService: dto.primaryService || lead.primaryService || conversation.primaryService,
          subServices: dto.subServices && dto.subServices.length > 0 ? dto.subServices : lead.subServices,
          patientName: dto.patientName || lead.patientName,
          patientAge: dto.patientAge ?? lead.patientAge,
          patientConditions: dto.patientConditions || lead.patientConditions,
          patientMobility: dto.patientMobility || lead.patientMobility,
          engagementType: dto.engagementType || lead.engagementType,
          careDurationCategory: dto.careDurationCategory || lead.careDurationCategory,
          careDuration: dto.careDuration || lead.careDuration,
          careSchedule: dto.careSchedule || lead.careSchedule,
          serviceAddress: dto.serviceAddress || lead.serviceAddress,
          cityDistrict: dto.cityDistrict || lead.cityDistrict,
          postalCode: dto.postalCode || lead.postalCode,
          pickupLocation: dto.pickupLocation || lead.pickupLocation,
          destinationLocation: dto.destinationLocation || lead.destinationLocation,
          isAmbulanceEmergency: isAmbulance,
          priority: leadPriority,
          omnichannelConversationId: conversationId,
        },
      });
    } else {
      // Create fresh lead
      lead = await this.prisma.lead.create({
        data: {
          customerName: name || 'Omnichannel Contact',
          phoneNumber: phone || `+910000000000_${Date.now()}`,
          email: email,
          serviceInterest: dto.primaryService || conversation.primaryService || null,
          source: (conversation.channel || 'OMNICHANNEL').toUpperCase(),
          status: 'NEW',
          priority: leadPriority,
          foundation: dto.foundation || conversation.foundation || 'UEC',
          enquiryCategory: dto.enquiryCategory || conversation.enquiryCategory || EnquiryCategory.SERVICE_ENQUIRY,
          primaryService: dto.primaryService || conversation.primaryService || null,
          subServices: dto.subServices || conversation.subServices || [],
          patientName: dto.patientName || null,
          patientAge: dto.patientAge ?? null,
          patientConditions: dto.patientConditions || null,
          patientMobility: dto.patientMobility || null,
          engagementType: dto.engagementType || null,
          careDurationCategory: dto.careDurationCategory || null,
          careDuration: dto.careDuration || null,
          careSchedule: dto.careSchedule || null,
          serviceAddress: dto.serviceAddress || null,
          cityDistrict: dto.cityDistrict || null,
          postalCode: dto.postalCode || null,
          pickupLocation: dto.pickupLocation || null,
          destinationLocation: dto.destinationLocation || null,
          isAmbulanceEmergency: isAmbulance,
          omnichannelConversationId: conversationId,
          assignedAgentId: dto.assignedAgentId || user?.agentId || null,
          notes: dto.notes || null,
        },
      });
    }

    // Link Lead to Conversation
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        leadId: lead.id,
        foundation: lead.foundation,
        enquiryCategory: lead.enquiryCategory,
        primaryService: lead.primaryService,
        subServices: lead.subServices,
        priority: isAmbulance ? Priority.EMERGENCY : conversation.priority,
      },
    });

    return lead;
  }

  // ==========================================
  // INBOUND & OUTBOUND CALL INTAKE FORM PERSISTENCE
  // ==========================================
  private normalizePhone(raw?: string | null): string {
    if (!raw) return '';
    let clean = String(raw).trim();
    try { clean = decodeURIComponent(clean); } catch (_) {}
    const lower = clean.toLowerCase();
    if (['unknown', 'anonymous', 'withheld', 'internal', 'private', 'none'].includes(lower)) {
      return '';
    }
    let digits = clean.replace(/[^\d+]/g, '');
    if (digits.startsWith('00')) digits = '+' + digits.substring(2);
    else if (digits.startsWith('0') && digits.length === 11) digits = '+91' + digits.substring(1);
    else if (!digits.startsWith('+') && digits.length === 10) digits = '+91' + digits;
    else if (!digits.startsWith('+') && digits.startsWith('91') && digits.length === 12) digits = '+' + digits;
    return digits;
  }

  async saveCallIntake(callSidOrId: string, dto: SaveCallIntakeDto, user: any) {
    // Locate call session by ID or reason (Vobiz provider callSid)
    const session = await this.prisma.callSession.findFirst({
      where: {
        OR: [
          { id: callSidOrId },
          { reason: callSidOrId },
          { livekitRoom: callSidOrId },
        ],
      },
      include: { lead: true, customer: true },
    });

    if (!session) throw new NotFoundException('CallSession not found');

    const isAmbulance =
      dto.foundation === 'AMBULANCE' ||
      dto.primaryService?.toLowerCase().includes('ambulance') ||
      dto.subServices?.some(s => s.toLowerCase().includes('ambulance'));

    const intakePayload = {
      ...dto,
      isAmbulance,
      savedAt: new Date().toISOString(),
      savedBy: user?.name || user?.email || 'Agent',
      authorId: user?.id || user?.userId,
    };

    // Update call session
    const updatedSession = await this.prisma.callSession.update({
      where: { id: session.id },
      data: {
        intakeForm: intakePayload,
        ...(dto.liveNotes ? { liveNotes: { text: dto.liveNotes, updatedAt: new Date().toISOString() } } : {}),
      },
    });

    // Update or link lead
    let targetLeadId = dto.leadId || session.leadId;
    const cleanPhone = this.normalizePhone(dto.phone || session.customer?.phone);

    if (!targetLeadId && cleanPhone) {
      // Find existing lead by phone to prevent duplicates
      const existing = await this.prisma.lead.findFirst({
        where: { phoneNumber: { contains: cleanPhone.slice(-10) } },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        targetLeadId = existing.id;
      } else {
        // Create brand new Lead
        const createdLead = await this.prisma.lead.create({
          data: {
            customerName: dto.enquirerName || session.customer?.name || 'Inbound Enquirer',
            phoneNumber: cleanPhone,
            email: dto.email || session.customer?.email || null,
            serviceInterest: dto.primaryService || dto.serviceCategory || 'Elder Care',
            source: (session as any).direction === 'OUTBOUND' || (session.reason && session.reason.includes('outbound')) ? 'Outbound Call' : 'Inbound Call',
            status: 'NEW',
            priority: isAmbulance ? LeadPriority.EMERGENCY : LeadPriority.NORMAL,
            foundation: dto.foundation || 'UEC',
            enquiryCategory: dto.enquiryCategory as any,
            primaryService: dto.primaryService || null,
            subServices: dto.subServices || [],
            patientName: dto.patientName || null,
            patientAge: dto.patientAge ?? null,
            patientConditions: dto.patientConditions || null,
            patientMobility: dto.patientMobility || null,
            engagementType: dto.engagementType || null,
            careDurationCategory: dto.careDurationCategory || null,
            careDuration: dto.careDuration || null,
            careSchedule: dto.careSchedule || null,
            serviceAddress: dto.serviceAddress || null,
            cityDistrict: dto.cityDistrict || null,
            postalCode: dto.postalCode || null,
            pickupLocation: dto.pickupLocation || null,
            destinationLocation: dto.destinationLocation || null,
            isAmbulanceEmergency: isAmbulance,
            notes: dto.liveNotes || null,
            assignedAgentId: user?.agentId || null,
          },
        });
        targetLeadId = createdLead.id;
      }
      // Link session to the lead
      await this.prisma.callSession.update({
        where: { id: session.id },
        data: { leadId: targetLeadId },
      });
    }

    let updatedLead: any = null;
    if (targetLeadId) {
      updatedLead = await this.prisma.lead.update({
        where: { id: targetLeadId },
        data: {
          ...(dto.enquirerName ? { customerName: dto.enquirerName } : {}),
          ...(dto.email ? { email: dto.email } : {}),
          ...(dto.foundation ? { foundation: dto.foundation } : {}),
          ...(dto.serviceCategory ? { serviceInterest: dto.serviceCategory } : {}),
          ...(dto.enquiryCategory ? { enquiryCategory: dto.enquiryCategory } : {}),
          ...(dto.primaryService ? { primaryService: dto.primaryService } : {}),
          ...(dto.subServices ? { subServices: dto.subServices } : {}),
          ...(dto.patientName ? { patientName: dto.patientName } : {}),
          ...(dto.patientAge !== undefined ? { patientAge: dto.patientAge } : {}),
          ...(dto.patientConditions ? { patientConditions: dto.patientConditions } : {}),
          ...(dto.patientMobility ? { patientMobility: dto.patientMobility } : {}),
          ...(dto.engagementType ? { engagementType: dto.engagementType } : {}),
          ...(dto.careDurationCategory ? { careDurationCategory: dto.careDurationCategory } : {}),
          ...(dto.careDuration ? { careDuration: dto.careDuration } : {}),
          ...(dto.careSchedule ? { careSchedule: dto.careSchedule } : {}),
          ...(dto.serviceAddress ? { serviceAddress: dto.serviceAddress } : {}),
          ...(dto.cityDistrict ? { cityDistrict: dto.cityDistrict } : {}),
          ...(dto.postalCode ? { postalCode: dto.postalCode } : {}),
          ...(dto.pickupLocation ? { pickupLocation: dto.pickupLocation } : {}),
          ...(dto.destinationLocation ? { destinationLocation: dto.destinationLocation } : {}),
          isAmbulanceEmergency: isAmbulance,
          priority: isAmbulance ? LeadPriority.EMERGENCY : undefined,
          ...(dto.liveNotes ? { notes: dto.liveNotes } : {}),
        },
      });

      // Schedule follow-up if requested
      if (dto.followupDate) {
        let agentId = user?.agentId;
        if (!agentId) {
          const fallbackAgent = await this.prisma.agent.findFirst();
          agentId = fallbackAgent?.id;
        }

        if (agentId) {
          await this.prisma.leadFollowup.create({
            data: {
              leadId: targetLeadId,
              assignedAgentId: agentId,
              followupDate: new Date(dto.followupDate),
              meetingType: 'CALLBACK',
              notes: dto.liveNotes || `Call intake disposition: ${dto.callOutcome || 'Completed'}`,
              status: 'PENDING',
            },
          });

          await this.prisma.lead.update({
            where: { id: targetLeadId },
            data: { status: 'FOLLOWUP_REQUIRED' },
          });
          updatedLead.status = 'FOLLOWUP_REQUIRED';
        }
      }
    }

    return { success: true, session: updatedSession, lead: updatedLead };
  }

  /**
   * Save or update structured enquiry directly (manual entry, website, or editing an existing lead)
   */
  async saveStructuredEnquiryLead(dto: SaveCallIntakeDto, user: any, leadId?: string) {
    const isAmbulance =
      dto.foundation === 'AMBULANCE' ||
      dto.primaryService?.toLowerCase().includes('ambulance') ||
      dto.subServices?.some(s => s.toLowerCase().includes('ambulance'));

    const cleanPhone = this.normalizePhone(dto.phone);
    if (!cleanPhone && !leadId) {
      throw new BadRequestException('Valid phone number is required for lead enquiry');
    }

    let targetLead = null;
    if (leadId) {
      targetLead = await this.prisma.lead.findUnique({ where: { id: leadId } });
      if (!targetLead) throw new NotFoundException('Lead not found');
    } else if (cleanPhone) {
      targetLead = await this.prisma.lead.findFirst({
        where: { phoneNumber: { contains: cleanPhone.slice(-10) } },
        orderBy: { createdAt: 'desc' },
      });
    }

    const leadPriority: LeadPriority = isAmbulance
      ? LeadPriority.EMERGENCY
      : dto.callbackPriority === 'HIGH'
      ? LeadPriority.HIGH
      : LeadPriority.NORMAL;

    let savedLead;
    if (targetLead) {
      // Update existing lead transactionally
      savedLead = await this.prisma.lead.update({
        where: { id: targetLead.id },
        data: {
          customerName: dto.enquirerName || targetLead.customerName,
          phoneNumber: cleanPhone || targetLead.phoneNumber,
          email: dto.email !== undefined ? dto.email : targetLead.email,
          serviceInterest: dto.primaryService || dto.serviceCategory || targetLead.serviceInterest,
          foundation: dto.foundation || targetLead.foundation || 'UEC',
          enquiryCategory: (dto.enquiryCategory as any) || targetLead.enquiryCategory,
          primaryService: dto.primaryService || targetLead.primaryService,
          subServices: dto.subServices && dto.subServices.length > 0 ? dto.subServices : targetLead.subServices,
          patientName: dto.patientName !== undefined ? dto.patientName : targetLead.patientName,
          patientAge: dto.patientAge !== undefined ? dto.patientAge : targetLead.patientAge,
          patientConditions: dto.patientConditions !== undefined ? dto.patientConditions : targetLead.patientConditions,
          patientMobility: dto.patientMobility || targetLead.patientMobility,
          engagementType: dto.engagementType || targetLead.engagementType,
          careDurationCategory: dto.careDurationCategory || targetLead.careDurationCategory,
          careDuration: dto.careDuration || targetLead.careDuration,
          careSchedule: dto.careSchedule || targetLead.careSchedule,
          serviceAddress: dto.serviceAddress !== undefined ? dto.serviceAddress : targetLead.serviceAddress,
          cityDistrict: dto.cityDistrict !== undefined ? dto.cityDistrict : targetLead.cityDistrict,
          postalCode: dto.postalCode !== undefined ? dto.postalCode : targetLead.postalCode,
          pickupLocation: dto.pickupLocation !== undefined ? dto.pickupLocation : targetLead.pickupLocation,
          destinationLocation: dto.destinationLocation !== undefined ? dto.destinationLocation : targetLead.destinationLocation,
          isAmbulanceEmergency: isAmbulance,
          priority: leadPriority,
          notes: dto.liveNotes !== undefined ? dto.liveNotes : targetLead.notes,
          ...(dto.status ? { status: dto.status as any } : {}),
        },
      });
    } else {
      // Create new lead
      savedLead = await this.prisma.lead.create({
        data: {
          customerName: dto.enquirerName || 'Enquirer',
          phoneNumber: cleanPhone,
          email: dto.email || null,
          serviceInterest: dto.primaryService || dto.serviceCategory || 'Elder Care',
          source: dto.source || 'Manual Entry',
          status: (dto.status as any) || 'NEW',
          priority: leadPriority,
          foundation: dto.foundation || 'UEC',
          enquiryCategory: (dto.enquiryCategory as any) || EnquiryCategory.SERVICE_ENQUIRY,
          primaryService: dto.primaryService || null,
          subServices: dto.subServices || [],
          patientName: dto.patientName || null,
          patientAge: dto.patientAge ?? null,
          patientConditions: dto.patientConditions || null,
          patientMobility: dto.patientMobility || null,
          engagementType: dto.engagementType || null,
          careDurationCategory: dto.careDurationCategory || null,
          careDuration: dto.careDuration || null,
          careSchedule: dto.careSchedule || null,
          serviceAddress: dto.serviceAddress || null,
          cityDistrict: dto.cityDistrict || null,
          postalCode: dto.postalCode || null,
          pickupLocation: dto.pickupLocation || null,
          destinationLocation: dto.destinationLocation || null,
          isAmbulanceEmergency: isAmbulance,
          notes: dto.liveNotes || null,
          assignedAgentId: user?.agentId || null,
        },
      });
    }

    // Schedule follow-up if date is specified
    if (dto.followupDate) {
      let agentId = user?.agentId;
      if (!agentId) {
        const fallbackAgent = await this.prisma.agent.findFirst();
        agentId = fallbackAgent?.id;
      }
      if (agentId) {
        await this.prisma.leadFollowup.create({
          data: {
            leadId: savedLead.id,
            assignedAgentId: agentId,
            followupDate: new Date(dto.followupDate),
            meetingType: 'CALLBACK',
            notes: dto.liveNotes || `Enquiry intake disposition: ${dto.callOutcome || 'Completed'}`,
            status: 'PENDING',
          },
        });
        await this.prisma.lead.update({
          where: { id: savedLead.id },
          data: { status: 'FOLLOWUP_REQUIRED' },
        });
        savedLead.status = 'FOLLOWUP_REQUIRED';
      }
    }

    return {
      success: true,
      lead: savedLead,
      message: targetLead ? 'Enquiry updated successfully' : 'Enquiry created successfully',
    };
  }

  // ==========================================
  // INCREMENTAL LIVE NOTES AUTO-SAVE
  // ==========================================
  async saveLiveNotes(targetType: 'call' | 'lead' | 'conversation', id: string, dto: SaveLiveNotesDto, user: any) {
    const timestamp = new Date().toISOString();
    const author = user?.name || dto.authorName || 'Agent';

    if (targetType === 'call') {
      const session = await this.prisma.callSession.findFirst({
        where: {
          OR: [{ id }, { reason: id }, { livekitRoom: id }],
        },
      });
      if (!session) throw new NotFoundException('CallSession not found');

      const existingNotes = (session.liveNotes as any) || {};
      const history = Array.isArray(existingNotes.history) ? existingNotes.history : [];
      history.push({ text: dto.text, timestamp, author });

      await this.prisma.callSession.update({
        where: { id: session.id },
        data: {
          liveNotes: {
            current: dto.text,
            lastUpdated: timestamp,
            lastAuthor: author,
            history: history.slice(-20), // Keep last 20 revisions
          },
        },
      });
    } else if (targetType === 'lead') {
      const lead = await this.prisma.lead.findUnique({ where: { id } });
      if (!lead) throw new NotFoundException('Lead not found');

      const existingNotes = (lead.liveNotes as any) || {};
      const history = Array.isArray(existingNotes.history) ? existingNotes.history : [];
      history.push({ text: dto.text, timestamp, author });

      await this.prisma.lead.update({
        where: { id },
        data: {
          liveNotes: {
            current: dto.text,
            lastUpdated: timestamp,
            lastAuthor: author,
            history: history.slice(-20),
          },
        },
      });
    } else if (targetType === 'conversation') {
      const conv = await this.prisma.conversation.findUnique({ where: { id } });
      if (!conv) throw new NotFoundException('Conversation not found');

      const meta = (conv.intakeMetadata as any) || {};
      meta.liveNotes = {
        current: dto.text,
        lastUpdated: timestamp,
        lastAuthor: author,
      };

      await this.prisma.conversation.update({
        where: { id },
        data: { intakeMetadata: meta },
      });
    }

    return {
      success: true,
      savedAt: timestamp,
      author,
    };
  }

  // ==========================================
  // AMBULANCE EMERGENCY OVERRIDE
  // ==========================================
  async overrideEmergencyPriority(dto: OverrideEmergencyPriorityDto, user: any) {
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER'].includes(user.role);
    if (!isElevated) {
      throw new ForbiddenException('Only Administrators and Supervisors are authorized to override emergency priority.');
    }

    if (!dto.overrideReason || dto.overrideReason.trim().length < 5) {
      throw new BadRequestException('A descriptive override reason is required.');
    }

    let previousPriority: Priority = Priority.EMERGENCY;
    if (dto.conversationId) {
      const conv = await this.prisma.conversation.findUnique({ where: { id: dto.conversationId } });
      if (conv) previousPriority = conv.priority;
    } else if (dto.leadId) {
      const lead = await this.prisma.lead.findUnique({ where: { id: dto.leadId } });
      if (lead) previousPriority = lead.priority as any;
    }

    const audit = await this.prisma.emergencyOverrideAudit.create({
      data: {
        leadId: dto.leadId || null,
        conversationId: dto.conversationId || null,
        previousPriority,
        newPriority: dto.newPriority,
        overrideReason: dto.overrideReason,
        overriddenById: user?.id || user?.userId || 'admin',
        overriddenByRole: user?.role || 'SUPER_ADMIN',
      },
    });

    if (dto.conversationId) {
      await this.prisma.conversation.update({
        where: { id: dto.conversationId },
        data: { priority: dto.newPriority },
      });
    }

    if (dto.leadId) {
      const leadPriority: LeadPriority =
        dto.newPriority === Priority.EMERGENCY
          ? LeadPriority.EMERGENCY
          : dto.newPriority === Priority.HIGH
          ? LeadPriority.HIGH
          : LeadPriority.NORMAL;

      await this.prisma.lead.update({
        where: { id: dto.leadId },
        data: {
          priority: leadPriority,
          isAmbulanceEmergency: dto.newPriority === Priority.EMERGENCY,
          emergencyOverrideReason: dto.overrideReason,
        },
      });
    }

    return { success: true, audit };
  }
}
