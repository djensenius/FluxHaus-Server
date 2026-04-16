/** Haversine distance between two coordinates in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Compute total GPS distance from a GeoJSON-style coordinate array [[lon,lat,alt?],...]. */
export function gpsDistanceFromTrack(track: number[][]): number {
  let total = 0;
  for (let i = 1; i < track.length; i += 1) {
    const [lon1, lat1] = track[i - 1];
    const [lon2, lat2] = track[i];
    if (Number.isFinite(lat1) && Number.isFinite(lon1) && Number.isFinite(lat2) && Number.isFinite(lon2)) {
      total += haversineKm(lat1, lon1, lat2, lon2);
    }
  }
  return total;
}
