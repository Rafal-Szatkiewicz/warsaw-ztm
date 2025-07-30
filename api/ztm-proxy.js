export default async function handler(req, res) {
  const url = "https://mkuran.pl/gtfs/warsaw/vehicles.pb";
  const response = await fetch(url);
  if (!response.ok) {
    res.status(response.status).send("Failed to fetch GTFS-RT data");
    return;
  }
  const arrayBuffer = await response.arrayBuffer();
  res.setHeader("Content-Type", "application/octet-stream");
  res.send(Buffer.from(arrayBuffer));
}
