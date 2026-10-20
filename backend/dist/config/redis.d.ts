import Redis from 'ioredis';
export declare const redis: Redis;
export declare const DRIVER_LOCATIONS_KEY = "driver_locations";
export declare const DRIVER_HEARTBEAT_PREFIX = "driver:heartbeat:";
export declare const DRIVER_LOCATION_RECORD_PREFIX = "driver:loc:";
export declare const DRIVER_ONLINE_PREFIX = "driver:online:";
export declare const DRIVER_ACTIVE_TRIP_TTL_S: number;
export declare const DRIVER_H3_CELL_PREFIX = "driver:h3:";
export declare const DRIVER_H3_INDEX_PREFIX = "drivers:h3:";
