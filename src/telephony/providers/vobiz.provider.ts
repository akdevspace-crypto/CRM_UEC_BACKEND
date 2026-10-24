import { Injectable, Logger } from '@nestjs/common';
import { TelephonyProvider, NormalizedCallEvent, OutboundCallRequest, ProviderCapabilities } from './telephony-provider.interface';
import { LivekitService } from '../livekit.service';

@Injectable()
export class VobizProvider implements TelephonyProvider {
  private readonly logger = new Logger(VobizProvider.name);

  constructor(private readonly livekitService: LivekitService) {}

  normalizeWebhookEvent(payload: any, method: string): NormalizedCallEvent {
    this.logger.log(`[VOBIZ-PAYLOAD-DEBUG] Method=${method} Payload=${JSON.stringify(payload)}`);
    const sanitizeRecursive = (obj: any): any => {
      if (!obj || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(sanitizeRecursive);
      const sanitized: any = {};
      const sensitiveKeys = ['authorization', 'token', 'secret', 'password', 'apikey', 'api_key', 'signature', 'x-auth-token', 'x-auth-id'];
      for (const [k, v] of Object.entries(obj)) {
        if (sensitiveKeys.some(sk => k.toLowerCase().includes(sk))) continue;
        sanitized[k] = sanitizeRecursive(v);
      }
      return sanitized;
    };

    // Candidates for Vobiz Call ID
    const providerCallId = 
      payload?.CallUUID ?? 
      payload?.SIPCallID ?? 
      payload?.RequestID ?? 
      payload?.CallSid ?? 
      payload?.sid ?? 
      null;
    
    if (!providerCallId) {
      const sanitizedPayload = sanitizeRecursive(payload);
      const candidateCallIds = Object.keys(sanitizedPayload).filter(k => k.toLowerCase().includes('id') || k.toLowerCase().includes('sid'));
      
      this.logger.log(`[Vobiz Webhook Diagnostic] eventType=${payload?.Status || payload?.DialCallStatus || 'unknown'} candidateCallIds=${candidateCallIds.join(',')} sanitizedPayload=${JSON.stringify(sanitizedPayload)}`);
    }

    const rawDirection = String(payload?.Direction || '').toLowerCase();
    const vobizTrunkNumber = (process.env.VOBIZ_PHONE_NUMBER || '+918064267760').replace(/[^0-9]/g, '');
    const fromClean = String(payload?.From || payload?.CallFrom || '').replace(/[^0-9]/g, '');
    const toClean = String(payload?.To || payload?.CallTo || '').replace(/[^0-9]/g, '');

    let direction: 'OUTBOUND' | 'INBOUND' = 'INBOUND';
    if (rawDirection.includes('outbound')) {
      direction = 'OUTBOUND';
    } else if (fromClean.length >= 8 && vobizTrunkNumber.length >= 8 && fromClean.endsWith(vobizTrunkNumber.slice(-10))) {
      direction = 'OUTBOUND';
    } else if (toClean.length >= 8 && vobizTrunkNumber.length >= 8 && toClean.endsWith(vobizTrunkNumber.slice(-10))) {
      direction = 'INBOUND';
    }
    
    // Status normalization
    let eventType: NormalizedCallEvent['eventType'] = 'CALL_RINGING'; // default
    const status = (payload?.DialCallStatus || payload?.CallStatus || payload?.Status || '').toLowerCase();
    
    if (['completed', 'ended'].includes(status)) {
      eventType = 'CALL_ENDED';
    } else if (['canceled', 'no-answer', 'missed'].includes(status)) {
      eventType = 'CALL_MISSED';
    } else if (['failed', 'busy'].includes(status)) {
      eventType = 'CALL_FAILED';
    } else if (['in-progress', 'answered', 'connected'].includes(status)) {
      eventType = 'CALL_CONNECTED';
    } else if (['initiated', 'ringing'].includes(status)) {
      eventType = 'CALL_INITIATED';
    }

    if (direction === 'INBOUND' && ['initiated', 'ringing'].includes(status)) {
      this.logger.log(`[INBOUND-CALL] vobiz_webhook_received | CallUUID=${payload?.CallUUID} | SIPCallID=${payload?.SIPCallID} | RequestID=${payload?.RequestID} | From=${payload?.From} | To=${payload?.To} | Direction=${payload?.Direction} | Status=${payload?.Status} | Vobiz TrunkID=${payload?.TrunkID} | Domain=${payload?.Domain}`);
    }

    const duration = parseInt(payload?.DialCallDuration || payload?.Duration || '0', 10);
    const recordingUrl = payload?.RecordingUrl || null;
    
    return {
      provider: 'vobiz',
      providerCallId,
      eventType,
      direction,
      fromNumber: payload?.From || payload?.CallFrom || 'Unknown',
      toNumber: payload?.To || payload?.CallTo || 'Unknown',
      roomName: payload?.roomName || null,
      duration,
      recordingUrl,
      errorCode: payload?.ErrorCode || payload?.DialCallErrorCode,
      errorMessage: payload?.ErrorMessage || payload?.DialCallErrorMessage,
      sipResponseCode: payload?.SipResponseCode,
      timestamp: new Date(),
      rawPayload: payload,
    };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      provider: 'vobiz',
      supportsInboundBridge: true,
      supportsOutboundApi: true,
      supportsRealtimeCapacityQuery: false,
      supportsCarrierQueue: false,
      supportsCarrierHold: true,
      supportsCarrierTransfer: true,
      defaultChannelCapacity: parseInt(process.env.VOBIZ_CHANNEL_CAPACITY || '3', 10),
      channelsPerCall: {
        inboundActive: 1,
        inboundHeld: 1,
        outboundActive: 1,
        warmTransfer: 2,
      },
    };
  }

  generateBridgeResponse(roomName: string, baseUrl: string): string {
    const livekitSipDomain = process.env.LIVEKIT_SIP_HOST || process.env.LIVEKIT_SIP_URI?.replace(/^sip:/, '') || '4c0ct02u07s.sip.livekit.cloud';
    return `
<Response>
    <Dial action="${baseUrl}/telephony/vobiz/status">
        <Sip>sip:${roomName}@${livekitSipDomain}</Sip>
    </Dial>
</Response>`.trim();
  }

  generateBusyResponse(): string {
    return `
<Response>
    <Speak>Thank you for calling ElderCare. All our care coordinators are currently assisting other families. Please hold while we connect you to the next available agent.</Speak>
</Response>`.trim();
  }

  generateHoldResponse(holdAudioUrl?: string): string {
    const audio = holdAudioUrl || `${process.env.BACKEND_URL || 'https://crm-uec-backend.onrender.com'}/audio/hold-music.mp3`;
    return `
<Response>
    <Play loop="0">${audio}</Play>
</Response>`.trim();
  }

  async initiateOutboundCall(request: OutboundCallRequest, roomName: string): Promise<any> {
    this.logger.log(`Initiating Vobiz Outbound SIP Call to ${request.to} via LiveKit`);
    const trunkId = process.env.LIVEKIT_VOBIZ_OUTBOUND_TRUNK_ID || 'ST_xsShWdBTtHZR';
    
    // Use LivekitService to create SIP Participant
    const sipParticipantIdentity = await this.livekitService.createSipParticipant(roomName, trunkId, request.to);
    
    return {
      provider: 'vobiz',
      roomName,
      status: 'INITIATED',
      sipParticipantIdentity
    };
  }
}
