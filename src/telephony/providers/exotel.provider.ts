import { Injectable, Logger } from '@nestjs/common';
import { TelephonyProvider, NormalizedCallEvent, OutboundCallRequest } from './telephony-provider.interface';
import fetch from 'node-fetch';

@Injectable()
export class ExotelProvider implements TelephonyProvider {
  private readonly logger = new Logger(ExotelProvider.name);

  normalizeWebhookEvent(payload: any, method: string): NormalizedCallEvent {
    // Exotel payloads are similar to TwiML
    const providerCallId = payload?.CallSid || 'unknown';
    const direction = payload?.Direction === 'outbound' ? 'OUTBOUND' : 'INBOUND';
    
    let eventType: NormalizedCallEvent['eventType'] = 'CALL_RINGING';
    const status = (payload?.Status || payload?.DialCallStatus || '').toLowerCase();
    
    if (['completed', 'ended'].includes(status)) {
      eventType = 'CALL_ENDED';
    } else if (['canceled', 'no-answer', 'missed'].includes(status)) {
      eventType = 'CALL_MISSED';
    } else if (['failed', 'busy'].includes(status)) {
      eventType = 'CALL_FAILED';
    } else if (['in-progress', 'answered'].includes(status)) {
      eventType = 'CALL_CONNECTED';
    } else if (['initiated'].includes(status)) {
      eventType = 'CALL_INITIATED';
    }

    const duration = parseInt(payload?.DialCallDuration || payload?.Duration || '0', 10);
    const recordingUrl = payload?.RecordingUrl || null;

    return {
      provider: 'exotel',
      providerCallId,
      eventType,
      direction,
      fromNumber: payload?.From || 'Unknown',
      toNumber: payload?.To || 'Unknown',
      duration,
      recordingUrl,
      timestamp: new Date(),
      rawPayload: payload,
    };
  }

  generateBridgeResponse(roomName: string, baseUrl: string): string {
    // The previous implementation for Exotel doesn't use LiveKit SIP bridging natively yet,
    // it likely uses traditional <Dial> to a phone number or an internal app.
    // For backward compatibility, we'll return a generic response.
    return `
<Response>
    <Say>Connecting via Exotel.</Say>
</Response>`.trim();
  }

  async initiateOutboundCall(request: OutboundCallRequest, roomName: string): Promise<any> {
    this.logger.log(`Initiating Exotel Outbound Call to ${request.to}`);
    // Exotel outbound uses their REST API
    const apiKey = process.env.EXOTEL_API_KEY;
    const apiToken = process.env.EXOTEL_API_TOKEN;
    const sid = process.env.EXOTEL_SID;
    const subdomain = process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com';
    const callerId = process.env.EXOTEL_CALLER_ID || 'Unknown';

    if (!apiKey || !apiToken || !sid) {
      throw new Error('Exotel credentials missing');
    }

    const auth = Buffer.from(`${apiKey}:${apiToken}`).toString('base64');
    
    const url = `https://${subdomain}/v1/Accounts/${sid}/Calls/connect.json`;
    const body = new URLSearchParams();
    body.append('From', request.to);
    body.append('To', callerId); // Usually Exotel connects Customer (From) to Agent (To) or vice versa

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    if (!res.ok) {
      const errorText = await res.text();
      this.logger.error(`Exotel API error: ${errorText}`);
      throw new Error('Failed to initiate Exotel call');
    }

    const data = (await res.json()) as any;
    return {
      provider: 'exotel',
      providerCallId: data?.Call?.Sid,
      status: 'INITIATED'
    };
  }
}
