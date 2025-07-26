// Vercel Serverless Function: /api/ztm-proxy.js
// Proxy do API ZTM z nagłówkiem CORS i obsługą dotenv
// Vercel Serverless Function: /api/ztm-proxy.js
// Proxy do vehicles.pb z mkuran.pl z nagłówkiem CORS

export default async function handler(req, res) {
  const url = 'https://mkuran.pl/gtfs/warsaw/vehicles.pb';
  try {
    const apiRes = await fetch(url);
    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error(`vehicles.pb fetch error: ${apiRes.status} - ${errText}`);
      throw new Error(`vehicles.pb returned ${apiRes.status}`);
    }
    const buffer = await apiRes.arrayBuffer();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error('Proxy error:', err.stack || err.message);
    res.status(500).json({ error: 'Proxy error', details: err.message });
  }
}
