import { PrismaClient } from '@prisma/client';
export declare const prisma: PrismaClient<{
    datasources: {
        db: {
            url: string;
        };
    } | undefined;
}, never, import("@prisma/client/runtime/library").DefaultArgs>;
export declare const primaryPrisma: PrismaClient<import(".prisma/client").Prisma.PrismaClientOptions, never, import("@prisma/client/runtime/library").DefaultArgs>;
