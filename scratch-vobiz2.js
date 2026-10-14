const https = require('https');
const authId = 'MA_VMODSCTW';
const authToken = 'H76HhWFnNDIyRRL3DvoQ1L3Gfv0fCOYxEno7bJL1q63JvpkAEt79PEz5ASwtOPbI';

async function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, { headers: { 'X-Auth-ID': authId, 'X-Auth-Token': authToken } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

async function probe() {
  const ids = [
    '45ed7303-7d6a-4bd1-a9a5-78ff51192cbd', // Hangup CallUUID
    'Ig8Btm8Db9RO2KovFZWhvyACvaF', // Initial CallUUID / SIPCallID
    '17ced45f-df4a-447f-982d-ee4ba1e1edd3' // BridgeUUID
  ];
  for (const id of ids) {
    const ep = `https://api.vobiz.ai/api/v1/Account/${authId}/Recording/?call_uuid=${id}`;
    const res = await fetchUrl(ep);
    console.log(id, '->', res.status, res.data);
  }
}
probe();
