import { pool, query } from '../../config/database';

export interface PlaceRow {
  id: string;
  name: string;
  formatted_address: string | null;
  street: string | null;
  city: string | null;
  state: string;
  zip: string | null;
  category: string;
  subcategory: string | null;
  lat: number;
  lon: number;
  distance_miles: number | null;
  text_score: number | null;
  combined_score: number | null;
}

export const RADII_MILES = [1, 3, 5, 10, 25, 50];

export const placesRepository = {
  async searchByTextAndProximity(
    queryText: string,
    lat: number,
    lon: number,
    limit = 15,
  ): Promise<PlaceRow[]> {
    const radii = RADII_MILES;

    for (const radius of radii) {
      const sql = `
        SELECT
          p.id,
          p.name,
          p.formatted_address,
          p.street,
          p.city,
          p.state,
          p.zip,
          p.category,
          p.subcategory,
          p.lat,
          p.lon,
          ROUND(
            (ST_Distance(
              p.location,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
            ) / 1609.34)::numeric, 2
          )::double precision AS distance_miles,
          similarity(p.name, $3) AS text_score,
          ROUND(
            (0.6 * GREATEST(
              similarity(p.name, $3)::double precision,
              CASE WHEN p.name ILIKE $3 THEN 0.8 ELSE 0.0 END
            ) + 0.4 * GREATEST(0.0, 1.0 - (ST_Distance(
              p.location,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
            ) / 1609.34) / 50.0))::numeric, 4
          )::double precision AS combined_score
        FROM places p
        WHERE
          (similarity(p.name, $3) > 0.1 OR p.name ILIKE '%' || $3 || '%')
          AND ST_DWithin(
            p.location,
            ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
            $4
          )
        ORDER BY combined_score DESC, distance_miles ASC, p.popularity DESC
        LIMIT $5
      `;

      const radiusMeters = radius * 1609.34;
      const result = await query(sql, [lat, lon, queryText, radiusMeters, limit]);

      if (result.rows.length > 0) {
        return result.rows.map(mapRow);
      }
    }

    return [];
  },

  async findByCategory(
    category: string,
    lat: number,
    lon: number,
    limit = 15,
  ): Promise<PlaceRow[]> {
    const sql = `
      SELECT
        p.id,
        p.name,
        p.formatted_address,
        p.street,
        p.city,
        p.state,
        p.zip,
        p.category,
        p.subcategory,
        p.lat,
        p.lon,
        ROUND(
          (ST_Distance(
            p.location,
            ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
          ) / 1609.34)::numeric, 2
        )::double precision AS distance_miles,
        1.0 AS text_score,
        ROUND(
          (0.4 * GREATEST(0.0, 1.0 - (ST_Distance(
            p.location,
            ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
          ) / 1609.34) / 50.0))::numeric, 4
        )::double precision AS combined_score
      FROM places p
      WHERE
        p.category = $3
        AND ST_DWithin(
          p.location,
          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
          80467.2
        )
      ORDER BY distance_miles ASC, p.popularity DESC
      LIMIT $4
    `;

    const result = await query(sql, [lat, lon, category, limit]);
    return result.rows.map(mapRow);
  },

  async bulkUpsert(places: Array<{
    name: string;
    formattedAddress?: string;
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
    category: string;
    subcategory?: string;
    lat: number;
    lon: number;
    phone?: string;
    website?: string;
    openingHours?: string;
    externalId?: string;
    popularity?: number;
  }>): Promise<number> {
    if (places.length === 0) return 0;

    let inserted = 0;
    for (const p of places) {
      if (!p.externalId) continue;
      const sql = `
        INSERT INTO places (
          name, formatted_address, street, city, state, zip,
          category, subcategory, lat, lon, location,
          phone, website, opening_hours, external_id, popularity, source
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          ST_SetSRID(ST_MakePoint($10, $9), 4326)::geography,
          $11, $12, $13, $14, $15, 'osm'
        )
        ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
          name = EXCLUDED.name,
          formatted_address = EXCLUDED.formatted_address,
          popularity = places.popularity + 1,
          updated_at = NOW()
      `;
      try {
        await query(sql, [
          p.name, p.formattedAddress ?? null, p.street ?? null,
          p.city ?? null, p.state ?? 'CA', p.zip ?? null,
          p.category, p.subcategory ?? null,
          p.lat, p.lon,
          p.phone ?? null, p.website ?? null, p.openingHours ?? null,
          p.externalId, p.popularity ?? 0,
        ]);
        inserted++;
      } catch {
        // Skip individual failures
      }
    }
    return inserted;
  },

  async count(): Promise<number> {
    const result = await query('SELECT COUNT(*)::int AS count FROM places');
    return result.rows[0]?.count ?? 0;
  },
};

function mapRow(row: any): PlaceRow {
  return {
    id: row.id,
    name: row.name,
    formatted_address: row.formatted_address,
    street: row.street,
    city: row.city,
    state: row.state,
    zip: row.zip,
    category: row.category,
    subcategory: row.subcategory,
    lat: parseFloat(row.lat),
    lon: parseFloat(row.lon),
    distance_miles: row.distance_miles != null ? parseFloat(row.distance_miles) : null,
    text_score: row.text_score != null ? parseFloat(row.text_score) : null,
    combined_score: row.combined_score != null ? parseFloat(row.combined_score) : null,
  };
}
