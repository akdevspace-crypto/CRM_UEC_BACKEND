export interface NormalizedCallEvent {
  provider: 'vobiz' | 'exotel';
  providerCallId: string;
  eventType: 'CALL_INITIATED' | 'CALL_RINGING' | 'CALL_ANSWERED' | 'CALL_CONNECTED' | 'CALL_ENDED' | 'CALL_FAILED' | 'CALL_MISSED' | 'RECORDING_READY' | 'TRANSCRIPT_READY';
  direction: 'INBOUND' | 'OUTBOUND';
  fromNumber: string;
  toNumber: string;
  roomName?: string;
  duration?: number;
  recordingUrl?: string;
  transcriptUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  sipResponseCode?: string;
  timestamp: Date;
  rawPayload: any;
}

export interface OutboundCallRequest {
  to: string;
  leadId?: string;
  contactId?: string;
  agentId: string;
}

export interface TelephonyProvider {
  /**
   * Normalizes an incoming webhook payload into a standard CRM call event.
   */
  normalizeWebhookEvent(payload: any, method: string): NormalizedCallEvent;

  /**
   * Generates the XML/TwiML response to bridge an incoming call to LiveKit/SIP.
   */
  generateBridgeResponse(roomName: string, baseUrl: string): string;

  /**
   * Initiates an outbound call via this provider.
   */
  initiateOutboundCall(request: OutboundCallRequest, roomName: string): Promise<any>;
}
