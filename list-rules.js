const { SipClient } = require('livekit-server-sdk');
require('dotenv').config({ path: 'd:/CRM/Backend/.env' });

async function listRules() {
  const url = process.env.LIVEKIT_API_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;

  const client = new SipClient(url, key, secret);
  try {
    const rules = await client.listSipDispatchRule();
    console.log(JSON.stringify(rules, null, 2));
  } catch (error) {
    console.error(error);
  }
}

listRules();
