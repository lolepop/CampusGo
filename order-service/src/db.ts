import pkg from 'npm:@prisma/client';
const { PrismaClient } = pkg;

// Export a single, reusable instance of the database client
export const prisma = new PrismaClient();