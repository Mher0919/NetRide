// backend/src/scripts/import-vehicle-db.ts
import axios from 'axios';
import { pool } from '../config/database';
import { v4 as uuidv4 } from 'uuid';

const DATA_URL = 'https://raw.githubusercontent.com/plowman/open-vehicle-db/master/data/makes_and_models.json';

async function importVehicles() {
  console.log('🚚 Starting vehicle database import...');
  
  try {
    const response = await axios.get(DATA_URL);
    const data = response.data; // Array of makes
    
    console.log(`🏢 Found ${data.length} makes.`);

    let totalInserted = 0;
    const batchSize = 1000;
    let currentBatch: any[] = [];

    for (const makeObj of data) {
      const makeName = makeObj.make_name;
      const models = makeObj.models; // Object where keys are model names
      
      for (const modelName of Object.keys(models)) {
        const modelObj = models[modelName];
        const years = modelObj.years; // Array of years
        
        for (const year of years) {
          currentBatch.push({ make: makeName, model: modelName, year: year });
          
          if (currentBatch.length >= batchSize) {
            await insertBatch(currentBatch);
            totalInserted += currentBatch.length;
            console.log(`✅ Inserted ${totalInserted} models...`);
            currentBatch = [];
          }
        }
      }
    }

    if (currentBatch.length > 0) {
      await insertBatch(currentBatch);
      totalInserted += currentBatch.length;
    }

    console.log(`🎉 Import complete! Total models: ${totalInserted}`);
  } catch (error: any) {
    console.error('❌ Import failed:', error.message);
  } finally {
    process.exit(0);
  }
}

async function insertBatch(batch: any[]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    for (const item of batch) {
      await client.query(
        'INSERT INTO vehicle_models (id, make, model, year) VALUES ($1, $2, $3, $4) ON CONFLICT (make, model, year) DO NOTHING',
        [uuidv4(), item.make, item.model, item.year]
      );
    }
    
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

importVehicles();
