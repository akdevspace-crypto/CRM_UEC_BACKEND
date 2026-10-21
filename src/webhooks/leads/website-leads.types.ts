export type WebsiteSourceId = 
  | 'anbu-sri-sai'
  | 'thathapatti'
  | 'thathapatti-homecare'
  | 'uncf-trust'
  | 'universal-eldercare'
  | 'zencura'
  | 'bytezcorp';

export interface WebsiteSourceConfig {
  sourceId: WebsiteSourceId;
  name: string;
  websiteUrl: string;
  envSecretKey: string;
  defaultSecret: string;
  defaultServiceInterest: string;
  sourceLabel: string;
  adapterType: 'custom_php_form' | 'wordpress_rest' | 'landing_page_enquiry';
}

export interface NormalizedLeadPayload {
  customerName: string;
  phoneNumber: string;
  email: string | null;
  serviceInterest: string | null;
  city: string | null;
  notes: string | null;
  source: string;
  externalLeadId: string | null;
  formLocation?: string | null;
  submittedAt?: string | null;
}

export interface IngestionResult {
  success: boolean;
  status: 'created' | 'existing_lead_updated' | 'duplicate_event' | 'error';
  leadId?: string;
  message: string;
  sourceId: WebsiteSourceId;
  externalLeadId?: string | null;
  timestamp: string;
}

export interface SourceSyncStatus {
  sourceId: WebsiteSourceId;
  name: string;
  websiteUrl: string;
  sourceLabel: string;
  enabled: boolean;
  configured: boolean;
  adapterType: string;
  totalReceived: number;
  recordsImported: number;
  duplicatesSkipped: number;
  lastReceivedAt: string | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  checkpointCursor?: string | null;
}

export interface HistoricalImportOptions {
  dryRun?: boolean;
  checkpoint?: string | null;
  simulateInterruptionAtIndex?: number;
}

export interface HistoricalImportResult {
  success: boolean;
  dryRun: boolean;
  sourceId: WebsiteSourceId;
  totalProvided: number;
  validRecords: number;
  invalidRecords: number;
  duplicatesSkipped: number;
  createdCount: number;
  updatedCount: number;
  attemptedCount?: number;
  remainingCount?: number;
  checkpointCursor?: string | null;
  errors: Array<{ index: number; error: string; raw?: any }>;
  sampleMapped?: NormalizedLeadPayload[];
}

