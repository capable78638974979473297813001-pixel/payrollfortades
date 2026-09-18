import type { Job } from './types.ts';

/**
 * Geofenced clock-ins — proving a worker was actually at the job site when
 * they punched in, not clocking a public-works shift from their couch.
 *
 * The whole thing is one honest number: the great-circle distance between where
 * the worker's phone says they are and where the job site is. If that distance
 * is inside the job's radius, the punch is on-site; if not, it is recorded
 * anyway but FLAGGED, so a foreman sees "clocked in 1.4 km from the site"
 * instead of discovering padded hours on the certified payroll weeks later.
 *
 * Deliberately advisory, never a hard block — the same stance payroll/
 * compliance.ts takes on minimum wage. GPS drifts, a big yard legitimately
 * exceeds a tight radius, a phone has no signal in a basement: refusing the
 * punch would lose real worked time. Flagging surfaces the exception and lets
 * a human judge it. A job with no location set has no geofence and every punch
 * is accepted plainly.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_METERS = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle (haversine) distance in metres between two lat/lng points, rounded to the metre. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h))));
}

export interface ClockVerification {
  /** false only when the job has a geofence AND the punch is outside it. A job with no location is always on-site (`true`) with a null distance. */
  onSite: boolean;
  /** Distance from the job site in metres, or null when the job has no location or the punch carried no coordinates. */
  distanceMeters: number | null;
  /** The job's radius, or null when it has no geofence. */
  radiusMeters: number | null;
  /** Human-readable note for the punch record. */
  note: string;
}

/**
 * Check a punch's coordinates against a job's geofence. When the job has no
 * location, or the punch carried no coordinates (permission denied, no signal),
 * the punch is treated as on-site rather than flagged — a missing GPS fix is
 * not evidence of a wrong-site punch, and flagging it would train foremen to
 * ignore the flag.
 */
export function verifyClockIn(job: Job, at: GeoPoint | null): ClockVerification {
  if (!job.location) {
    return { onSite: true, distanceMeters: null, radiusMeters: null, note: 'No geofence on this job — punch accepted.' };
  }
  if (!at) {
    return { onSite: true, distanceMeters: null, radiusMeters: job.location.radiusMeters, note: 'No location from device — punch accepted, but unverified.' };
  }
  const dist = distanceMeters(at, job.location);
  const onSite = dist <= job.location.radiusMeters;
  return {
    onSite,
    distanceMeters: dist,
    radiusMeters: job.location.radiusMeters,
    note: onSite
      ? `On site (${dist} m from centre, within ${job.location.radiusMeters} m).`
      : `Off site — ${dist} m from the job, outside the ${job.location.radiusMeters} m radius. Flagged for review.`,
  };
}

/** A recorded clock punch, with whatever geofence verification applied at the time. */
export interface ClockEvent {
  id: string;
  companyId: string;
  employeeId: string;
  jobId: string;
  type: 'in' | 'out';
  /** ISO datetime of the punch. */
  at: string;
  /** Where the device said it was, when it said anything. */
  coords: GeoPoint | null;
  onSite: boolean;
  distanceMeters: number | null;
  note: string;
  /** What the worker typed for where the job is — an address or site the crew app asks for at clock-in, shown on the punch for the foreman. */
  where?: string;
}
