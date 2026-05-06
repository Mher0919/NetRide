"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/benchmark_routing.ts
const axios_1 = __importDefault(require("axios"));
const API_URL = 'http://localhost:3000/api/geospatial/route';
const TEST_CASES = [
    {
        name: 'LAX to Santa Monica',
        start: [33.9416, -118.4085],
        end: [34.0195, -118.4912]
    },
    {
        name: 'Hollywood to Downtown LA',
        start: [34.0928, -118.3287],
        end: [34.0407, -118.2468]
    }
];
async function runBenchmark() {
    console.log('--- Starting Routing Benchmark (LA Coordinates) ---');
    for (const testCase of TEST_CASES) {
        console.log(`\nTesting: ${testCase.name}`);
        // 1. Cold Call (OSRM + ML ETA)
        console.log('Requesting Route...');
        const start1 = Date.now();
        try {
            const res1 = await axios_1.default.post(API_URL, {
                start: testCase.start,
                end: testCase.end
            });
            const duration1 = Date.now() - start1;
            console.log(`Response Time: ${duration1}ms | Cache Hit: ${res1.data.cache_hit} | Engine: ${res1.data.engine} | ETA: ${res1.data.eta}s`);
        }
        catch (err) {
            console.error('Failed:', err.message);
        }
        // 2. Warm Call (Redis L1)
        console.log('Requesting Route (Cache check)...');
        const start2 = Date.now();
        try {
            const res2 = await axios_1.default.post(API_URL, {
                start: testCase.start,
                end: testCase.end
            });
            const duration2 = Date.now() - start2;
            console.log(`Response Time: ${duration2}ms | Cache Hit: ${res2.data.cache_hit} | Engine: ${res2.data.engine}`);
        }
        catch (err) {
            console.error('Failed:', err.message);
        }
    }
    console.log('\n--- Benchmark Finished ---');
}
runBenchmark();
//# sourceMappingURL=benchmark_routing.js.map