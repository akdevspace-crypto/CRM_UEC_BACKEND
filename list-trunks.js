const { SipClient } = require('livekit-server-sdk');
require('dotenv').config({ path: 'd:/CRM/Backend/.env' });

async function listTrunks() {
  const url = process.env.LIVEKIT_API_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;

  console.log(`Using URL: ${url}`);
  const client = new SipClient(url, key, secret);

  try {
    const inboundTrunks = await client.listSipInboundTrunk();
    console.log('Inbound Trunks:', inboundTrunks.map(t => ({ id: t.sipTrunkId, name: t.name, numbers: t.numbers })));
    
    const outboundTrunks = await client.listSipOutboundTrunk();
    console.log('Outbound Trunks:', outboundTrunks.map(t => ({ id: t.sipTrunkId, name: t.name, numbers: t.numbers })));
  } catch (error) {
    console.error('Error listing trunks:', error);
  }
}

listTrunks();
