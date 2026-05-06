export declare const env: {
    NODE_ENV: "development" | "production" | "test";
    PORT: string;
    DATABASE_URL: string;
    REDIS_URL: string;
    JWT_SECRET: string;
    OSRM_URL: string;
    DRIVER_MATCH_RADIUS_KM: number;
    DRIVER_ACCEPT_TIMEOUT_MS: number;
    EMAIL_FROM: string;
    APP_URL: string;
    GOOGLE_MAPS_API_KEY?: string | undefined;
    GMAIL_CLIENT_ID?: string | undefined;
    GMAIL_CLIENT_SECRET?: string | undefined;
    GMAIL_REFRESH_TOKEN?: string | undefined;
    GMAIL_USER_EMAIL?: string | undefined;
};
