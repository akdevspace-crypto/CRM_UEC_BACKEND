const https = require('https');

const callUuid = '45ed7303-7d6a-4bd1-a9a5-78ff51192cbd';
const authId = 'MA_VMODSCTW';
const authToken = 'H76HhWFnNDIyRRL3DvoQ1L3Gfv0fCOYxEno7bJL1q63JvpkAEt79PEz5ASwtOPbI';

async function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'X-Auth-ID': authId,
        'X-Auth-Token': authToken
      }
    };
    https.get(urlStr, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

async function probe() {
  const endpoints = [
    `https://api.vobiz.ai/api/v1/Recording?call_uuid=${callUuid}`,
    `https://api.vobiz.ai/api/v1/Recordings?call_uuid=${callUuid}`,
    `https://api.vobiz.ai/api/v1/Account/${authId}/Recording/?call_uuid=${callUuid}`,
    `https://api.vobiz.ai/api/v1/call/recording/${callUuid}`
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetchUrl(ep);
      console.log('GET', ep, '->', res.status);
      if (res.status === 200 || res.status === 201) {
         console.log(res.data);
      }
    } catch(e) {
      console.log(ep, 'Error:', e.message);
    }
  }
}
probe();
