export const LA_REGION = {
  minLat: 33.5,
  maxLat: 34.8,
  minLng: -119.0,
  maxLng: -116.9,
};

export function isInLARegion(lat: number, lng: number): boolean {
  return (
    lat >= LA_REGION.minLat &&
    lat <= LA_REGION.maxLat &&
    lng >= LA_REGION.minLng &&
    lng <= LA_REGION.maxLng
  );
}

export function bothInLARegion(
  origin: [number, number],
  destination: [number, number],
): boolean {
  return isInLARegion(origin[0], origin[1]) && isInLARegion(destination[0], destination[1]);
}
