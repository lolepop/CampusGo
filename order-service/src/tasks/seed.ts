import log from "../log.ts";
// Seeds dummy errands for UI testing.
// Run with: deno task seed
// supplierIds refer to the supplier service's CSV seed (ids 1-21 on a fresh supplier database);
// pickupLocation is the snapshot text the order service builds from that supplier.
import { db } from "../prisma/db.ts";

const hours = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000).toISOString();

const orders = [
    { requesterId: 2, supplierId: 4, pickupLocation: "Cool Spot, Com 2, Level 1", dropoffLocation: "Foyer@PGP", itemDescription: "Iced lemon tea and a tuna sandwich", creditBounty: 5, status: "OPEN", expiresAt: hours(24) },
    { requesterId: 3, courierId: 1, supplierId: 2, pickupLocation: "NUS Co-op, Central Library, Level 1", dropoffLocation: "COM2", itemDescription: "NUS hoodie (size M)", creditBounty: 3, status: "ACCEPTED", expiresAt: hours(24) },
    { requesterId: 4, supplierId: 12, pickupLocation: "TOMORO COFFEE, Hon Sui Sen Memorial Library, Level 2", dropoffLocation: "Tembusu College", itemDescription: "Iced Americano", creditBounty: 2, status: "OPEN", expiresAt: hours(2) },
    { requesterId: 5, supplierId: 3, pickupLocation: "Printer @ Com 2, Com 2, Level 1", dropoffLocation: "COM1 Level 2", itemDescription: "Printed CS3230 assignment", creditBounty: 1, status: "OPEN", expiresAt: hours(5) },
    { requesterId: 6, courierId: 2, supplierId: 11, pickupLocation: "Pasta Express, Frontier, Level 1", dropoffLocation: "Eusoff Hall", itemDescription: "Carbonara (extra cheese)", creditBounty: 3, status: "ACCEPTED", expiresAt: hours(1) },
    { requesterId: 7, supplierId: 16, pickupLocation: "Cheers Unmanned Convenience Store, Engineering Block E3, Level 4", dropoffLocation: "YIH Study Room", itemDescription: "USB-C charging cable", creditBounty: 4, status: "OPEN", expiresAt: hours(24) },
    { requesterId: 8, courierId: 3, supplierId: 15, pickupLocation: "Goh Bros E-Print Pte Ltd, Yusof Ishak House, Level 5", dropoffLocation: "UHC", itemDescription: "Bound project report", creditBounty: 2, status: "ACCEPTED", expiresAt: hours(12) },
    { requesterId: 9, supplierId: 10, pickupLocation: "Central Square @ YIH, Yusof Ishak House, Level 1", dropoffLocation: "COM2 SR3", itemDescription: "Chicken rice (chilli on the side)", creditBounty: 5, status: "OPEN", expiresAt: hours(24) },
    { requesterId: 10, supplierId: 14, pickupLocation: "Smooy, Com 3, Level 1", dropoffLocation: "Raffles Hall", itemDescription: "Frozen yoghurt cup", creditBounty: 2, status: "OPEN", expiresAt: hours(4) },
    { requesterId: 11, courierId: 7, supplierId: 18, pickupLocation: "Supersnacks, Prince George's Park, Level 1", dropoffLocation: "PGP House", itemDescription: "Snack box for study group", creditBounty: 6, status: "ACCEPTED", expiresAt: hours(2) },
    { requesterId: 12, supplierId: 20, pickupLocation: "The Coffee Roaster, Blk AS8, Level 1", dropoffLocation: "Sheares Hall", itemDescription: "Flat white (oat milk)", creditBounty: 3, status: "OPEN", expiresAt: hours(1) },
    { requesterId: 13, supplierId: 7, pickupLocation: "A Hot Hideout, Prince George's Park, Level 2", dropoffLocation: "King Edward VII Hall", itemDescription: "Mala hotpot (mild)", creditBounty: 4, status: "OPEN", expiresAt: hours(48) },
] as const;

if (import.meta.main) {
    for (const order of orders) {
        await db.orm.public.Order.create({ id: crypto.randomUUID(), ...order });
    }
    log.info(`Database seeded with ${orders.length} dummy orders for UI testing.`);
    await db.close?.();
}
