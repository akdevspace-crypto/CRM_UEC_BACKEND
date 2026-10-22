import { SopDepartment, SopPriority, SopRecurrence } from '@prisma/client';

export interface SeedTemplateStep {
  stepOrder: number;
  title: string;
  description: string;
  isMandatory: boolean;
  requiresAttachment?: boolean;
  requiresNotes?: boolean;
  estimatedMinutes?: number;
  roleRequired?: string;
}

export interface SeedTemplate {
  code: string;
  title: string;
  description: string;
  department: SopDepartment;
  category: string;
  priority: SopPriority;
  recurrence: SopRecurrence;
  requiresApproval: boolean;
  escalationHours: number;
  steps: SeedTemplateStep[];
}

export const SEED_SOP_TEMPLATES: SeedTemplate[] = [
  // ==========================================
  // HR SOP TEMPLATES
  // ==========================================
  {
    code: 'HR-ONB-01',
    title: 'Employee Onboarding & Document Verification',
    description: 'Standard procedure for onboarding new healthcare staff, caregivers, and administrative employees.',
    department: SopDepartment.HR,
    category: 'Employee Onboarding',
    priority: SopPriority.HIGH,
    recurrence: SopRecurrence.EVENT_TRIGGERED,
    requiresApproval: true,
    escalationHours: 48,
    steps: [
      { stepOrder: 1, title: 'Verify Personal Identification & Address Proof', description: 'Collect Aadhaar/ID, Passport, address proof and verify details.', isMandatory: true, requiresAttachment: true, estimatedMinutes: 15, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 2, title: 'Background Check & Police Clearance', description: 'Initiate and review criminal background check and reference checks.', isMandatory: true, requiresAttachment: true, estimatedMinutes: 30, roleRequired: 'HR_MANAGER' },
      { stepOrder: 3, title: 'Medical Fitness & Vaccination Clearance', description: 'Review medical fitness certificate, TB screening, and vaccination history.', isMandatory: true, requiresAttachment: true, estimatedMinutes: 15, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 4, title: 'Issue Employee ID & CRM Account Creation', description: 'Create user account in ElderCare CRM, assign department, designation, and unit.', isMandatory: true, requiresNotes: true, estimatedMinutes: 10, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 5, title: 'SOP & Safety Training Acknowledgement', description: 'Ensure the employee signs and acknowledges all elder care and emergency protocols.', isMandatory: true, requiresNotes: true, estimatedMinutes: 20, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 6, title: 'Manager Sign-off & Onboarding Completion', description: 'Reporting manager final review and approval for deployment readiness.', isMandatory: true, estimatedMinutes: 10, roleRequired: 'HR_MANAGER' },
    ],
  },
  {
    code: 'HR-STF-02',
    title: 'Staff Verification & Care Readiness Audit',
    description: 'Periodic and on-demand verification of staff qualifications, care skills, and deployment readiness.',
    department: SopDepartment.HR,
    category: 'Staff Verification',
    priority: SopPriority.NORMAL,
    recurrence: SopRecurrence.MONTHLY,
    requiresApproval: true,
    escalationHours: 24,
    steps: [
      { stepOrder: 1, title: 'Audit Nursing & Caregiving Certificates', description: 'Verify current validity of nursing license, CPR, and basic life support certifications.', isMandatory: true, requiresAttachment: true, estimatedMinutes: 20, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 2, title: 'Update Care Competency Tags', description: 'Update caregiver skill inventory: dementia care, bedridden care, post-surgery, palliative care.', isMandatory: true, requiresNotes: true, estimatedMinutes: 15, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 3, title: 'Availability & Shift Schedule Confirmation', description: 'Confirm availability for day/night/24-hr shifts and preferred operational units.', isMandatory: true, estimatedMinutes: 10, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 4, title: 'Flag Outstanding Discrepancies', description: 'Mark any incomplete profiles or expiring certifications with corrective deadlines.', isMandatory: false, requiresNotes: true, estimatedMinutes: 15, roleRequired: 'HR_MANAGER' },
    ],
  },
  {
    code: 'HR-DEP-03',
    title: 'Staff Deployment & Care Matching Handover',
    description: 'Operational matching of qualified healthcare personnel to customer service requests received from Sales or CCR.',
    department: SopDepartment.HR,
    category: 'Staff Deployment',
    priority: SopPriority.URGENT,
    recurrence: SopRecurrence.EVENT_TRIGGERED,
    requiresApproval: true,
    escalationHours: 12,
    steps: [
      { stepOrder: 1, title: 'Review Patient Care Requirements', description: 'Inspect lead/customer medical condition, mobility needs, gender preferences, and schedule.', isMandatory: true, requiresNotes: true, estimatedMinutes: 15, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 2, title: 'Shortlist Eligible & Available Staff', description: 'Filter active staff by skills, location proximity, and readiness status.', isMandatory: true, estimatedMinutes: 20, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 3, title: 'Staff Briefing & Assignment Acceptance', description: 'Contact caregiver, explain patient requirements, and record assignment confirmation.', isMandatory: true, requiresNotes: true, estimatedMinutes: 15, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 4, title: 'Customer Profile Dispatch & Welcome Handover', description: 'Send caregiver profile and credentials to customer family via WhatsApp/Email.', isMandatory: true, requiresAttachment: false, estimatedMinutes: 10, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 5, title: 'Supervisor Deployment Authorization', description: 'Supervisor verifies matching criteria and signs off active care deployment.', isMandatory: true, estimatedMinutes: 10, roleRequired: 'SUPERVISOR' },
    ],
  },
  {
    code: 'HR-DLY-04',
    title: 'Daily HR Operations & Shift Handover',
    description: 'Daily operational checklist for HR coordinators covering attendance, leave, unassigned requests, and shift handover.',
    department: SopDepartment.HR,
    category: 'Daily Operations',
    priority: SopPriority.NORMAL,
    recurrence: SopRecurrence.DAILY,
    requiresApproval: false,
    escalationHours: 8,
    steps: [
      { stepOrder: 1, title: 'Morning Attendance & Unplanned Leave Triage', description: 'Audit daily check-ins across units, identify absent caregivers, and trigger replacement.', isMandatory: true, requiresNotes: true, estimatedMinutes: 25, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 2, title: 'Process Pending Staff-Matching Requests', description: 'Review queue of pending care assignments submitted by Sales and CCR.', isMandatory: true, estimatedMinutes: 30, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 3, title: 'Follow Up Expiring Staff Documents', description: 'Send notifications to staff whose certifications or IDs expire within 15 days.', isMandatory: true, estimatedMinutes: 20, roleRequired: 'HR_COORDINATOR' },
      { stepOrder: 4, title: 'Submit Daily HR Operations Log', description: 'Record daily shift attendance summary, open issues, and hand over to evening coordinator.', isMandatory: true, requiresNotes: true, estimatedMinutes: 15, roleRequired: 'HR_COORDINATOR' },
    ],
  },

  // ==========================================
  // CCR SOP TEMPLATES
  // ==========================================
  {
    code: 'CCR-ENQ-01',
    title: 'Incoming Customer Enquiry Registration & Triage',
    description: 'Standard protocol for answering, classifying, and routing new patient or family care enquiries across all channels.',
    department: SopDepartment.CCR,
    category: 'Enquiry Handling',
    priority: SopPriority.HIGH,
    recurrence: SopRecurrence.EVENT_TRIGGERED,
    requiresApproval: false,
    escalationHours: 4,
    steps: [
      { stepOrder: 1, title: 'Identify Caller & Verify Existing CRM Records', description: 'Search customer database by phone/email; link to existing customer or initiate new record.', isMandatory: true, estimatedMinutes: 5, roleRequired: 'CCR_AGENT' },
      { stepOrder: 2, title: 'Capture Care Needs & Medical Context', description: 'Record patient age, primary diagnosis, care service interest (Elder Care, ICU at Home, Physio).', isMandatory: true, requiresNotes: true, estimatedMinutes: 10, roleRequired: 'CCR_AGENT' },
      { stepOrder: 3, title: 'Classify Urgency & Assign Priority', description: 'Designate enquiry priority: Emergency, Immediate (24hr), or General Enquiry.', isMandatory: true, estimatedMinutes: 5, roleRequired: 'CCR_AGENT' },
      { stepOrder: 4, title: 'Route to Sales or Care Coordinator', description: 'Forward qualified care requirements to Sales Team or dispatch immediate emergency alert.', isMandatory: true, requiresNotes: true, estimatedMinutes: 5, roleRequired: 'CCR_AGENT' },
    ],
  },
  {
    code: 'CCR-COM-02',
    title: 'Customer Complaint Resolution & Escalation',
    description: 'Structured escalation and resolution procedure for service dissatisfaction, caregiver issues, or billing queries.',
    department: SopDepartment.CCR,
    category: 'Complaint Management',
    priority: SopPriority.URGENT,
    recurrence: SopRecurrence.EVENT_TRIGGERED,
    requiresApproval: true,
    escalationHours: 12,
    steps: [
      { stepOrder: 1, title: 'Register Complaint & Issue Severity Rating', description: 'Log issue details, categorize severity (Critical/High/Medium), create ticket reference.', isMandatory: true, requiresNotes: true, estimatedMinutes: 10, roleRequired: 'CCR_AGENT' },
      { stepOrder: 2, title: 'Root Cause Investigation with Field Operations', description: 'Contact assigned caregiver and field supervisor to investigate complaint facts.', isMandatory: true, requiresNotes: true, estimatedMinutes: 30, roleRequired: 'CCR_SUPERVISOR' },
      { stepOrder: 3, title: 'Propose Corrective Action or Caregiver Replacement', description: 'Formulate resolution plan (e.g. staff replacement, supervisor home visit, credit adjustments).', isMandatory: true, requiresNotes: true, estimatedMinutes: 20, roleRequired: 'CCR_SUPERVISOR' },
      { stepOrder: 4, title: 'Customer Resolution Call & Confirmation', description: 'Call the customer family, present resolution, and verify their satisfaction.', isMandatory: true, requiresNotes: true, estimatedMinutes: 15, roleRequired: 'CCR_AGENT' },
      { stepOrder: 5, title: 'Management Review & Ticket Closure', description: 'Operations Manager reviews corrective action and formally closes the complaint ticket.', isMandatory: true, estimatedMinutes: 10, roleRequired: 'OPERATIONS_MANAGER' },
    ],
  },
  {
    code: 'CCR-DLY-03',
    title: 'CCR Daily Shift Operations & Call Queue Review',
    description: 'Daily operational workflow for customer care representatives ensuring no missed callbacks or unhandled customer messages.',
    department: SopDepartment.CCR,
    category: 'Daily Operations',
    priority: SopPriority.NORMAL,
    recurrence: SopRecurrence.DAILY,
    requiresApproval: false,
    escalationHours: 8,
    steps: [
      { stepOrder: 1, title: 'Morning Omnichannel Message Clearance', description: 'Audit unread WhatsApp, Email, and Instagram customer messages; clear backlog.', isMandatory: true, estimatedMinutes: 20, roleRequired: 'CCR_AGENT' },
      { stepOrder: 2, title: 'Scheduled Callback Queue Execution', description: 'Call all customers with callbacks due in the current shift window.', isMandatory: true, requiresNotes: true, estimatedMinutes: 45, roleRequired: 'CCR_AGENT' },
      { stepOrder: 3, title: 'Emergency Alert & Critical Ticket Review', description: 'Ensure all high-severity tickets have active owner and are progressing within SLA.', isMandatory: true, estimatedMinutes: 20, roleRequired: 'CCR_SUPERVISOR' },
      { stepOrder: 4, title: 'End-of-Shift Handover Log', description: 'Document pending enquiries, unresolved tickets, and pass baton to next shift.', isMandatory: true, requiresNotes: true, estimatedMinutes: 15, roleRequired: 'CCR_AGENT' },
    ],
  },

  // ==========================================
  // SALES TEAM SOP TEMPLATES
  // ==========================================
  {
    code: 'SAL-QLF-01',
    title: 'Lead Qualification & Care Plan Assessment',
    description: 'Procedure for contacting new elder care leads, establishing clinical suitability, and structuring care packages.',
    department: SopDepartment.SALES,
    category: 'Lead Qualification',
    priority: SopPriority.HIGH,
    recurrence: SopRecurrence.EVENT_TRIGGERED,
    requiresApproval: false,
    escalationHours: 12,
    steps: [
      { stepOrder: 1, title: 'Speed-to-Lead Outbound Contact', description: 'Call new lead within 15 minutes of registration; record call outcome in CRM.', isMandatory: true, requiresNotes: true, estimatedMinutes: 15, roleRequired: 'SALES_AGENT' },
      { stepOrder: 2, title: 'Detailed Care Assessment Intake', description: 'Capture patient diagnosis, ADL assistance requirements, shift hours, and family budget.', isMandatory: true, requiresNotes: true, estimatedMinutes: 20, roleRequired: 'SALES_AGENT' },
      { stepOrder: 3, title: 'Update Opportunity Stage & Conversion Score', description: 'Advance lead to QUALIFIED or POSITIVE stage; record Gemini conversion score.', isMandatory: true, estimatedMinutes: 5, roleRequired: 'SALES_AGENT' },
      { stepOrder: 4, title: 'Schedule Follow-Up Consultation or Home Assessment', description: 'Book appointment with Clinical Assessment Doctor or Sales Specialist.', isMandatory: true, estimatedMinutes: 10, roleRequired: 'SALES_AGENT' },
    ],
  },
  {
    code: 'SAL-FLW-02',
    title: 'Sales Follow-Up & Quotation Management',
    description: 'Protocol for issuing personalized care quotations, conducting follow-ups, and handling family queries.',
    department: SopDepartment.SALES,
    category: 'Follow-Up Management',
    priority: SopPriority.NORMAL,
    recurrence: SopRecurrence.EVENT_TRIGGERED,
    requiresApproval: false,
    escalationHours: 24,
    steps: [
      { stepOrder: 1, title: 'Generate & Dispatch Service Quotation', description: 'Create quotation in CRM, attach care inclusions, and send via WhatsApp & Email.', isMandatory: true, requiresAttachment: true, estimatedMinutes: 15, roleRequired: 'SALES_AGENT' },
      { stepOrder: 2, title: 'Conduct Scheduled Follow-Up Call', description: 'Review quotation terms with primary decision maker; address scope and pricing questions.', isMandatory: true, requiresNotes: true, estimatedMinutes: 20, roleRequired: 'SALES_AGENT' },
      { stepOrder: 3, title: 'Handle Objections & Propose Adjustments', description: 'Adjust service tier or caregiver hours if required; update quotation revision.', isMandatory: false, requiresNotes: true, estimatedMinutes: 15, roleRequired: 'SALES_AGENT' },
      { stepOrder: 4, title: 'Request HR Staff Availability Check', description: 'Submit staff-matching request to HR for preliminary caregiver verification.', isMandatory: true, requiresNotes: true, estimatedMinutes: 10, roleRequired: 'SALES_AGENT' },
    ],
  },
  {
    code: 'SAL-CLS-03',
    title: 'Deal Conversion & Post-Sale Service Handover',
    description: 'Final closure protocol: billing confirmation, payment collection, service agreement signing, and clinical handover.',
    department: SopDepartment.SALES,
    category: 'Post-Conversion',
    priority: SopPriority.HIGH,
    recurrence: SopRecurrence.EVENT_TRIGGERED,
    requiresApproval: true,
    escalationHours: 24,
    steps: [
      { stepOrder: 1, title: 'Verify Signed Service Agreement', description: 'Collect signed patient care contract, terms of engagement, and consent forms.', isMandatory: true, requiresAttachment: true, estimatedMinutes: 15, roleRequired: 'SALES_AGENT' },
      { stepOrder: 2, title: 'Record Advance Payment & Invoice Generation', description: 'Record payment transaction reference in CRM, verify payment receipt, trigger invoice.', isMandatory: true, requiresAttachment: true, estimatedMinutes: 10, roleRequired: 'SALES_AGENT' },
      { stepOrder: 3, title: 'Trigger HR Staff Deployment Handoff', description: 'Formalize handoff to HR for confirmed caregiver dispatch and service start date.', isMandatory: true, requiresNotes: true, estimatedMinutes: 15, roleRequired: 'SALES_AGENT' },
      { stepOrder: 4, title: 'Sales Manager Commission & Deal Sign-Off', description: 'Sales Manager verifies revenue attribution, contract terms, and closes opportunity as WON.', isMandatory: true, estimatedMinutes: 10, roleRequired: 'SALES_MANAGER' },
    ],
  },
  {
    code: 'SAL-DLY-04',
    title: 'Daily Sales Operations & Target Pipeline Review',
    description: 'Daily operational workflow for sales reps and managers covering pipeline reviews, call targets, and follow-up deadlines.',
    department: SopDepartment.SALES,
    category: 'Daily Operations',
    priority: SopPriority.NORMAL,
    recurrence: SopRecurrence.DAILY,
    requiresApproval: false,
    escalationHours: 8,
    steps: [
      { stepOrder: 1, title: 'Morning Uncontacted Lead Pool Audit', description: 'Review newly assigned leads in pool, identify leads nearing SLA breach, plan call list.', isMandatory: true, estimatedMinutes: 20, roleRequired: 'SALES_AGENT' },
      { stepOrder: 2, title: 'Execute Scheduled Calls & Follow-Ups', description: 'Complete all callback reminders and scheduled phone consultations for the day.', isMandatory: true, requiresNotes: true, estimatedMinutes: 60, roleRequired: 'SALES_AGENT' },
      { stepOrder: 3, title: 'Review Pending Quotations & Expiry Dates', description: 'Follow up with families whose quotations expire within 48 hours.', isMandatory: true, estimatedMinutes: 20, roleRequired: 'SALES_AGENT' },
      { stepOrder: 4, title: 'Daily Activity & Target Summary Submission', description: 'Submit daily calls logged, leads qualified, conversions achieved, and notes.', isMandatory: true, requiresNotes: true, estimatedMinutes: 15, roleRequired: 'SALES_AGENT' },
    ],
  },

  // ==========================================
  // DATA ENTRY SOP TEMPLATES
  // ==========================================
  {
    code: 'DAT-VAL-01',
    title: 'Lead & Customer Data Quality Verification',
    description: 'Protocol for auditing incoming web submissions, batch uploads, and manual entries for accuracy, deduplication, and completeness.',
    department: SopDepartment.DATA_ENTRY,
    category: 'Data Quality',
    priority: SopPriority.NORMAL,
    recurrence: SopRecurrence.DAILY,
    requiresApproval: true,
    escalationHours: 24,
    steps: [
      { stepOrder: 1, title: 'Audit Contact Details & Phone Format Validation', description: 'Validate 10-digit phone number format, remove invalid characters, ensure unique country code.', isMandatory: true, estimatedMinutes: 15, roleRequired: 'DATA_OPERATOR' },
      { stepOrder: 2, title: 'Deduplicate Against Existing Customer Database', description: 'Check potential duplicate profiles by phone, email, and family contact; merge if duplicate.', isMandatory: true, requiresNotes: true, estimatedMinutes: 20, roleRequired: 'DATA_OPERATOR' },
      { stepOrder: 3, title: 'Standardize Address, City & Unit Assignment', description: 'Verify service delivery location matches service coverage area and assign to correct unit.', isMandatory: true, estimatedMinutes: 15, roleRequired: 'DATA_OPERATOR' },
      { stepOrder: 4, title: 'Supervisor Approval for Data Correction Batches', description: 'Data Quality Supervisor audits merged/purged records and approves batch changes.', isMandatory: true, estimatedMinutes: 10, roleRequired: 'SUPERVISOR' },
    ],
  },
  {
    code: 'DAT-STF-02',
    title: 'Staff Profile & Certification Record Maintenance',
    description: 'Maintenance workflow for digitizing, cataloging, and updating staff profiles, nursing credentials, and emergency records.',
    department: SopDepartment.DATA_ENTRY,
    category: 'Staff Data Maintenance',
    priority: SopPriority.NORMAL,
    recurrence: SopRecurrence.WEEKLY,
    requiresApproval: true,
    escalationHours: 48,
    steps: [
      { stepOrder: 1, title: 'Digitize & Index Physical Staff Documents', description: 'Scan and index ID cards, medical certificates, and educational transcripts into CRM document storage.', isMandatory: true, requiresAttachment: true, estimatedMinutes: 30, roleRequired: 'DATA_OPERATOR' },
      { stepOrder: 2, title: 'Verify Employee Master Fields', description: 'Ensure employeeId, bank details, emergency contacts, and blood group are populated.', isMandatory: true, estimatedMinutes: 20, roleRequired: 'DATA_OPERATOR' },
      { stepOrder: 3, title: 'Submit Profile for HR Officer Verification', description: 'Route updated profile to HR team for operational sign-off.', isMandatory: true, requiresNotes: true, estimatedMinutes: 10, roleRequired: 'DATA_OPERATOR' },
    ],
  },
  {
    code: 'DAT-DLY-03',
    title: 'Daily Data Operations & Exception Clearing',
    description: 'End-of-day data-entry reconciliation to process rejected records, fix validation exceptions, and produce daily audit summaries.',
    department: SopDepartment.DATA_ENTRY,
    category: 'Daily Operations',
    priority: SopPriority.NORMAL,
    recurrence: SopRecurrence.DAILY,
    requiresApproval: false,
    escalationHours: 8,
    steps: [
      { stepOrder: 1, title: 'Clear Failed Webhook & Import Queue', description: 'Inspect error logs from website lead submissions and excel uploads; correct failed records.', isMandatory: true, requiresNotes: true, estimatedMinutes: 30, roleRequired: 'DATA_OPERATOR' },
      { stepOrder: 2, title: 'Enrich Incomplete Customer Profiles', description: 'Fill in missing fields from recent call transcripts, omnichannel chats, and care summaries.', isMandatory: true, estimatedMinutes: 25, roleRequired: 'DATA_OPERATOR' },
      { stepOrder: 3, title: 'Submit Daily Data Quality Handover Log', description: 'Record records created, records corrected, duplicates merged, and open exceptions.', isMandatory: true, requiresNotes: true, estimatedMinutes: 15, roleRequired: 'DATA_OPERATOR' },
    ],
  },
];
