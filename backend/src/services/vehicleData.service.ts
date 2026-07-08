import axios from 'axios';
import { redis } from '../config/redis';

export class VehicleDataService {
  private static readonly NHTSA_BASE_URL = 'https://vpic.nhtsa.dot.gov/api/vehicles';
  private static readonly CACHE_TTL = 86400 * 7; // 1 week cache

  /**
   * Fetches all makes from NHTSA and caches them.
   */
  static async getMakes(): Promise<string[]> {
    const cacheKey = 'vehicles:makes';
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      console.log('[VEHICLE DATA] 🚗 Fetching master makes list from NHTSA...');
      const response = await axios.get(`${this.NHTSA_BASE_URL}/GetMakesForVehicleType/car?format=json`);
      const makes = response.data.Results
        .map((r: any) => r.MakeName.trim())
        .filter((name: string) => name.length > 0)
        .sort();

      await redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(makes));
      return makes;
    } catch (error: any) {
      console.error(`[VEHICLE DATA] ❌ Failed to fetch makes: ${error.message}`);
      // Fallback to minimal list if API is down and cache is empty
      return ['Acura', 'Audi', 'BMW', 'Cadillac', 'Chevrolet', 'Ford', 'Honda', 'Lexus', 'Mercedes-Benz', 'Tesla', 'Toyota'];
    }
  }

  /**
   * Fetches models for a specific make and caches them.
   */
  static async getModels(make: string): Promise<string[]> {
    const cacheKey = `vehicles:models:${make.toLowerCase()}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    try {
      console.log(`[VEHICLE DATA] 🚙 Fetching models for ${make}...`);
      const response = await axios.get(`${this.NHTSA_BASE_URL}/GetModelsForMake/${make}?format=json`);
      const models = response.data.Results
        .map((r: any) => r.Model_Name.trim())
        .filter((name: string) => name.length > 0)
        .sort();

      await redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(models));
      return models;
    } catch (error: any) {
      console.error(`[VEHICLE DATA] ❌ Failed to fetch models for ${make}: ${error.message}`);
      return [];
    }
  }

  /**
   * Background sync job to pre-populate common makes and models.
   */
  static async syncCommonVehicles() {
    const topMakes = ['Tesla', 'Toyota', 'Mercedes-Benz', 'BMW', 'Audi', 'Lexus', 'Honda', 'Ford', 'Chevrolet', 'Cadillac', 'Porsche'];
    console.log('[VEHICLE SYNC] 🔄 Starting background sync for top manufacturers...');
    
    await this.getMakes(); // Refresh master makes list

    for (const make of topMakes) {
      await this.getModels(make);
      // Be nice to the government API, small delay between calls
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('[VEHICLE SYNC] ✅ Background sync completed.');
  }

  /**
   * Search across makes and models (Real-time).
   */
  static async searchVehicles(query: string) {
    if (!query) return [];

    const makes = await this.getMakes();
    const normalizedQuery = query.toLowerCase();
    
    // 1. Filter makes
    const filteredMakes = makes.filter(m => m.toLowerCase().includes(normalizedQuery));
    
    // 2. If the query exactly matches a make, or there's only one make result, also return its models
    let modelResults: any[] = [];
    if (filteredMakes.length === 1 || makes.some(m => m.toLowerCase() === normalizedQuery)) {
      const targetMake = filteredMakes.length === 1 ? filteredMakes[0] : makes.find(m => m.toLowerCase() === normalizedQuery)!;
      const models = await this.getModels(targetMake);
      modelResults = models.map(m => ({ type: 'MODEL', name: m, make: targetMake }));
    }

    const results = [
      ...filteredMakes.map(m => ({ type: 'MAKE', name: m })),
      ...modelResults
    ];

    return results.slice(0, 100); // Limit results for performance
  }
}
