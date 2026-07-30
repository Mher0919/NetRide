// backend/src/scripts/import-pois.ts
// Fetches POI data from Overpass API for California and imports into the
// local places table with PostGIS spatial indexing.
//
// Usage: npx ts-node src/scripts/import-pois.ts [--categories coffee,gas,restaurant]
//        npx ts-node src/scripts/import-pois.ts --all    # Import all categories
//        npx ts-node src/scripts/import-pois.ts --count  # Count existing places

import axios from 'axios';
import { pool } from '../config/database';
import * as dotenv from 'dotenv';
dotenv.config();

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const CA_BOUNDS = '32.5,-124.5,42.0,-114.0'; // south,west,north,east

interface POICategory {
  name: string;
  overpassQuery: string;
  category: string;
  subcategory?: string;
}

const CATEGORIES: POICategory[] = [
  // Coffee & cafes
  { name: 'coffee', overpassQuery: 'node["amenity"="cafe"]({{bbox}});node["amenity"="coffee_shop"]({{bbox}});', category: 'cafe', subcategory: 'coffee' },
  { name: 'coffee_brands', overpassQuery: 'node["name"~"Starbucks|Coffee Bean|Peet",i]({{bbox}});', category: 'cafe', subcategory: 'coffee' },

  // Restaurants & fast food
  { name: 'restaurant', overpassQuery: 'node["amenity"="restaurant"]({{bbox}});', category: 'restaurant' },
  { name: 'fast_food', overpassQuery: 'node["amenity"="fast_food"]({{bbox}});', category: 'fast_food' },

  // Gas stations
  { name: 'fuel', overpassQuery: 'node["amenity"="fuel"]({{bbox}});node["shop"="gas"]({{bbox}});', category: 'fuel' },

  // Hospitals & medical
  { name: 'hospital', overpassQuery: 'node["amenity"="hospital"]({{bbox}});', category: 'hospital' },
  { name: 'clinic', overpassQuery: 'node["amenity"="clinic"]({{bbox}});', category: 'clinic', subcategory: 'medical' },
  { name: 'pharmacy', overpassQuery: 'node["amenity"="pharmacy"]({{bbox}});', category: 'pharmacy' },

  // Schools & education
  { name: 'school', overpassQuery: 'node["amenity"="school"]({{bbox}});', category: 'school' },
  { name: 'university', overpassQuery: 'node["amenity"="university"]({{bbox}});node["amenity"="college"]({{bbox}});', category: 'university' },

  // Hotels & lodging
  { name: 'hotel', overpassQuery: 'node["tourism"="hotel"]({{bbox}});node["tourism"="motel"]({{bbox}});node["tourism"="hostel"]({{bbox}});', category: 'hotel', subcategory: 'lodging' },

  // Transport
  { name: 'airport', overpassQuery: 'node["aeroway"="aerodrome"]({{bbox}});', category: 'airport' },
  { name: 'bus_station', overpassQuery: 'node["amenity"="bus_station"]({{bbox}});', category: 'bus_station', subcategory: 'transit' },
  { name: 'train_station', overpassQuery: 'node["railway"="station"]({{bbox}});', category: 'train_station', subcategory: 'transit' },

  // Shopping
  { name: 'supermarket', overpassQuery: 'node["shop"="supermarket"]({{bbox}});node["shop"="convenience"]({{bbox}});', category: 'grocery' },
  { name: 'mall', overpassQuery: 'node["shop"="mall"]({{bbox}});', category: 'shopping', subcategory: 'mall' },
  { name: 'department_store', overpassQuery: 'node["shop"="department_store"]({{bbox}});', category: 'shopping', subcategory: 'department_store' },

  // Banks & ATMs
  { name: 'bank', overpassQuery: 'node["amenity"="bank"]({{bbox}});', category: 'bank' },
  { name: 'atm', overpassQuery: 'node["amenity"="atm"]({{bbox}});', category: 'atm', subcategory: 'financial' },

  // Parks & leisure
  { name: 'park', overpassQuery: 'node["leisure"="park"]({{bbox}});', category: 'park', subcategory: 'leisure' },
  { name: 'gym', overpassQuery: 'node["leisure"="fitness_centre"]({{bbox}});node["amenity"="gym"]({{bbox}});', category: 'gym', subcategory: 'fitness' },

  // Entertainment
  { name: 'cinema', overpassQuery: 'node["amenity"="cinema"]({{bbox}});node["amenity"="theatre"]({{bbox}});', category: 'entertainment', subcategory: 'cinema' },
  { name: 'nightclub', overpassQuery: 'node["amenity"="nightclub"]({{bbox}});node["amenity"="bar"]({{bbox}});', category: 'nightlife' },

  // Other common searches
  { name: 'police', overpassQuery: 'node["amenity"="police"]({{bbox}});', category: 'police', subcategory: 'emergency' },
  { name: 'fire_station', overpassQuery: 'node["amenity"="fire_station"]({{bbox}});', category: 'fire_station', subcategory: 'emergency' },
  { name: 'library', overpassQuery: 'node["amenity"="library"]({{bbox}});', category: 'library' },
  { name: 'post_office', overpassQuery: 'node["amenity"="post_office"]({{bbox}});', category: 'post_office' },
  { name: 'car_repair', overpassQuery: 'node["shop"="car_repair"]({{bbox}});', category: 'car_repair', subcategory: 'automotive' },
];

async function fetchOverpass(query: string): Promise<any[]> {
  const fullQuery = `[out:json][timeout:60];(${query.replace('{{bbox}}', CA_BOUNDS)});out center 50;`;
  try {
    const resp = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(fullQuery)}`, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'NetRide-POIImport/1.0',
      },
      timeout: 65000,
    });
    return resp.data?.elements ?? [];
  } catch (err: any) {
    console.error(`  Overpass error: ${err.message}`);
    return [];
  }
}

async function importCategory(cat: POICategory): Promise<number> {
  console.log(`\n📦 Importing ${cat.name}...`);
  const elements = await fetchOverpass(cat.overpassQuery);
  console.log(`  Fetched ${elements.length} raw elements`);

  let imported = 0;
  let skipped = 0;

  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = tags.name || tags.brand || tags.operator || '';
    if (!name) { skipped++; continue; }

    const elLat = el.type === 'node' ? el.lat : el.center?.lat;
    const elLon = el.type === 'node' ? el.lon : el.center?.lon;
    if (!Number.isFinite(elLat) || !Number.isFinite(elLon)) { skipped++; continue; }

    const addrParts = [
      tags['addr:housenumber'],
      tags['addr:street'],
    ].filter(Boolean);
    const street = addrParts.join(' ');
    const city = tags['addr:city'] || '';
    const zip = tags['addr:postcode'] || '';

    const formattedAddress = [street, city, 'CA', zip].filter(Boolean).join(', ');

    if (!el.id) { skipped++; continue; }
    const externalId = String(el.id);
    try {
      await pool.query(`
        INSERT INTO places (
          name, formatted_address, street, city, state, zip,
          category, subcategory, lat, lon, location,
          phone, website, opening_hours, external_id, popularity, source
        ) VALUES ($1, $2, $3, $4, 'CA', $5, $6, $7, $8, $9,
          ST_SetSRID(ST_MakePoint($9, $8), 4326)::geography,
          $10, $11, $12, $13, 1, 'osm')
        ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
          name = EXCLUDED.name,
          popularity = places.popularity + 1,
          updated_at = NOW()
      `, [
        name, formattedAddress, street || null, city, zip || null,
        cat.category, cat.subcategory || null,
        elLat, elLon,
        tags.phone || null, tags.website || null,
        tags.opening_hours || null,
        externalId,
      ]);
      imported++;
    } catch (err: any) {
      skipped++;
    }
  }

  console.log(`  ✅ Imported: ${imported}, Skipped: ${skipped}`);
  return imported;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--count')) {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM places');
    console.log(`\n📊 Total places in database: ${result.rows[0].count}`);
    await pool.end();
    return;
  }

  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS "postgis";
    CREATE EXTENSION IF NOT EXISTS "pg_trgm";
  `);

  let totalImported = 0;

  if (args.includes('--all')) {
    for (const cat of CATEGORIES) {
      totalImported += await importCategory(cat);
    }
  } else {
    const specificCategories = args
      .filter(a => !a.startsWith('--'))
      .flatMap(a => a.split(','));

    if (specificCategories.length > 0) {
      const cats = CATEGORIES.filter(c => specificCategories.includes(c.name));
      for (const cat of cats) {
        totalImported += await importCategory(cat);
      }
    } else {
      for (const cat of CATEGORIES) {
        totalImported += await importCategory(cat);
      }
    }
  }

  console.log(`\n🎉 Total imported: ${totalImported} places`);

  const countResult = await pool.query('SELECT COUNT(*)::int AS c FROM places');
  console.log(`📊 Total places in database: ${countResult.rows[0].c}`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
