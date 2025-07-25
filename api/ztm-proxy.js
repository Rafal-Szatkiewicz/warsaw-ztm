// Vercel Serverless Function: /api/ztm-proxy.js
// Proxy do API ZTM z nagłówkiem CORS

export default async function handler(req, res) {
  // Skonstruuj URL do API ZTM na podstawie query stringa
  const base = "https://api.um.warszawa.pl/api/action/busestrams_get/";
  const qs = req.url.split('?')[1] || '';
  const url = `${base}?${qs}`;

  // Pobierz dane z API ZTM
  const apiRes = await fetch(url);
  const data = await apiRes.text(); // API ZTM zwraca JSON jako tekst

  // Dodaj nagłówki CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(data);
}
