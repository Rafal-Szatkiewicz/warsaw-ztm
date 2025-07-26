// Vercel Serverless Function: /api/ztm-proxy.js
// Proxy do API ZTM z nagłówkiem CORS i obsługą dotenv
import dotenv from 'dotenv';
dotenv.config();

export default async function handler(req, res) {
  // Pobierz API key z env (nigdy z frontu)
  const apiKey = process.env.ZTM_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'API key not set in environment' });
    return;
  }
  // Skonstruuj URL do API ZTM na podstawie query stringa, bez apikey
  const base = "https://api.um.warszawa.pl/api/action/busestrams_get/";
  const { resource_id, type } = req.query;
  if (!resource_id || !type) {
    res.status(400).json({ error: 'Missing resource_id or type' });
    return;
  }
  const url = `${base}?resource_id=${resource_id}&apikey=${apiKey}&type=${type}`;
  //console.log('Proxying request to:', url);

  try {
    const apiRes = await fetch(url, {
      headers: {
        'User-Agent': 'warsaw-ztm-proxy/1.0 (Vercel)',
        'Access-Control-Allow-Origin': "*"
      }
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error(`ZTM fetch error: ${apiRes.status} - ${errText}`);
      throw new Error(`ZTM API returned ${apiRes.status}`);
    }
    else
    {
      const errText = await apiRes.text();
      console.error(`ZTM fetch error: ${apiRes.status} - ${errText}`);
    }


    const data = await apiRes.text(); 
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(data);
  } catch (err) {
    console.error('Proxy error:', err.stack || err.message);
    res.status(500).json({ error: 'Proxy error', details: err.message });
  }
}
