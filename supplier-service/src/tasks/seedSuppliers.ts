import log from "../log.ts";
// Read the csv seed data file with Deno.readTextFile()
// Parse the file with a CSV library, using the first row as column names
// Convert each field, trim names and descriptions, map each CSV category 
// to the supplier categories

// AI-generated(edited by <Jun Yi>)
import { parse } from "jsr:@std/csv@1";
import { SupplierType } from "../common.ts";

interface SeedSupplier {
    name: string;
    type: SupplierType[];
    building: string;
    floor: number | null;
    description: string | null;
    opensAt: string | null;
    closesAt: string | null;
    imageUrl: string | null;
}

const categoryMap = new Map<string, SupplierType>([
    ["food", SupplierType.Food],
    ["coffee", SupplierType.Coffee],
    ["shopping", SupplierType.Shopping],
    ["printing", SupplierType.Printing],
]);


function normalizeBuilding(value: string): string {
    const name = value
        .trim()
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/\s+/g, " ");

    // "Com2", "COM2", and "Com 2" refer to the same building.
    return name.replace(/^com\s*(\d+)$/i, "Com $1");
}

function parseFloor(value: string): number | null {
    if (!value) return null;

    if (!/^-?\d+$/.test(value)) {
        throw new Error(`Invalid floor: "${value}"`);
    }
    
    const floor = Number(value);
    if (!Number.isInteger(floor) || floor < -2147483648 || floor > 2147483647) {
        throw new Error(`Floor is outside the supported range: "${value}"`);
    }

    return floor;
}

function parseTime(value: string): string | null {
    if (!value) return null;

    const match = /^([01]\d|2[0-3])([0-5]\d)hrs$/i.exec(value);
    if (!match) {
        throw new Error(`Invalid time: "${value}" (expected e.g. 0900hrs)`);
    }

    return `${match[1]}:${match[2]}`;
}

function parseImageUrl(value: string): string | null {
    if (!value) return null;

    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Image URL must use HTTP or HTTPS");
    }

    // Convert GitHub file pages into directly accessible image URLs.
    if (url.hostname === "github.com" && url.pathname.includes("/blob/")) {
        url.hostname = "raw.githubusercontent.com";
        url.pathname = url.pathname.replace("/blob/", "/");
    }

    return url.toString();
}

export async function main() {
    const path = Deno.args[0];
    const dryRun = Deno.args.includes("--dry-run");
    const actorArg = Deno.args.find(arg => arg.startsWith("--actor-id="));
    const actorId = Number(actorArg?.split("=")[1]);
    if (!dryRun && (!Number.isInteger(actorId) || actorId <= 0 || actorId > 2147483647)) {
        throw new Error("Provide --actor-id=<existing-user-id>, or --dry-run to preview");
    }
    if (!path) {
        throw new Error(
            "Usage: deno task seed <csv-path|-> --actor-id=<user-id> [--dry-run]",
        );
    }

    const csv = (await (path === "-" ? new Response(Deno.stdin.readable).text() : Deno.readTextFile(path))).replace(/^\uFEFF/, "");
    const rows = parse(csv, { skipFirstRow: true });

    const suppliers: SeedSupplier[] = [];
    const errors: string[] = [];
    const seenNames = new Set<string>();

    for (const [index, row] of rows.entries()) {
        try {
            const get = (column: string): string => {
                if (!(column in row)) {
                    throw new Error(`Missing CSV column: "${column}"`);
                }
                return row[column].trim();
            };

            const name = get("Name");
            if (!name) throw new Error("Name is required");

            const nameKey = name.toLowerCase();
            if (seenNames.has(nameKey)) {
                throw new Error(`Duplicate supplier name: "${name}"`);
            }

            const category = get("Type");
            const type = [...new Set(category.split("/").map(value => {
                const mapped = categoryMap.get(value.trim().toLowerCase());
                if (!mapped) throw new Error(`Unknown supplier category: "${value}"`);
                return mapped;
            }))];

            const building = normalizeBuilding(get("Building"));
            if (!building) throw new Error("Building is required");

            const opensAt = parseTime(get("StartingTime"));
            const closesAt = parseTime(get("ClosingTime"));
            if ((opensAt === null) !== (closesAt === null)) {
                throw new Error("Opening and closing times must both be provided");
            }

            suppliers.push({
                name,
                type,
                building,
                floor: parseFloor(get("Floor")),
                description: get("Location Description") || null,
                opensAt,
                closesAt,
                imageUrl: parseImageUrl(get("ImageURL")),
            });

            seenNames.add(nameKey);
        } catch (error) {
            const message = error instanceof Error
                ? error.message
                : String(error);

            // Record numbers count the header as record 1.
            errors.push(`CSV record ${index + 2}: ${message}`);
        }
    }

    if (errors.length > 0) {
        throw new Error(`CSV validation failed:\n${errors.join("\n")}`);
    }

    if (suppliers.length === 0) {
        throw new Error("CSV contains no supplier records");
    }

    if (dryRun) {
        log.info(JSON.stringify(suppliers, null, 2));
        log.info(`Validated ${suppliers.length} suppliers across ${new Set(suppliers.map(s => s.building)).size} buildings. No database changes made.`);
        return;
    }
    if (!Deno.env.get("DATABASE_URL")) throw new Error("DATABASE_URL is required");
    const { db } = await import("../prisma/db.ts");
    const { param } = await import("@prisma/orm-postgres/relational-core/expression");
    const text = (value: string | null) => param(value, { codecId: "pg/text@1" });
    const int = (value: number | null) => param(value, { codecId: "pg/int4@1" });
    try {
        const result = await db.transaction(async tx => {
            // Serialize seed runs and other writes while checking existing names.
            await tx.execute(db.raw.sql`LOCK TABLE location, supplier IN SHARE ROW EXCLUSIVE MODE`.affectedCount().build());
            const locations = await tx.query(db.raw.sql`SELECT id, name FROM location`
                .returnsRow({ id: "pg/int4@1", name: "pg/text@1" }).build());
            const locationIds = new Map<string, number>();
            for (const location of locations) {
                const key = normalizeBuilding(location.name).toLowerCase();
                if (locationIds.has(key)) throw new Error(`Ambiguous existing location: ${location.name}`);
                locationIds.set(key, location.id);
            }
            // Include deleted suppliers: seeding must never resurrect them.
            const existing = await tx.query(db.raw.sql`SELECT name FROM supplier`
                .returnsRow({ name: "pg/text@1" }).build());
            const names = new Set(existing.map(s => s.name.toLowerCase()));
            let createdLocations = 0;
            let createdSuppliers = 0;
            let skippedSuppliers = 0;
            for (const building of new Set(suppliers.map(s => s.building))) {
                const key = building.toLowerCase();
                if (locationIds.has(key)) continue;
                const [location] = await tx.query(db.raw.sql`
                    INSERT INTO location (name) VALUES (${text(building)}) RETURNING id`
                    .returnsRow({ id: "pg/int4@1" }).build());
                locationIds.set(key, location.id);
                createdLocations++;
            }
            for (const supplier of suppliers) {
                if (names.has(supplier.name.toLowerCase())) {
                    skippedSuppliers++;
                    continue;
                }
                const categories = param(supplier.type, { codecId: "pg/text-array@1" });
                const [created] = await tx.query(db.raw.sql`
                    INSERT INTO supplier (name, type, floor, "imageUrl", description, "locationId",
                        "opensAt", "closesAt", "createdBy", "updatedBy")
                    VALUES (${text(supplier.name)}, ${categories}::text[], ${int(supplier.floor)},
                        ${text(supplier.imageUrl)}, ${text(supplier.description)},
                        ${int(locationIds.get(supplier.building.toLowerCase())!)},
                        ${text(supplier.opensAt)}::time, ${text(supplier.closesAt)}::time,
                        ${int(actorId)}, ${int(actorId)}) RETURNING id`
                    .returnsRow({ id: "pg/int4@1" }).build());
                await tx.execute(db.raw.sql`
                    INSERT INTO "supplierAuditLog" ("supplierId", action, "actorUserId", snapshot)
                    SELECT id, 'create', ${int(actorId)}, row_to_json(s)
                    FROM supplier s WHERE id = ${int(created.id)}`.affectedCount().build());
                names.add(supplier.name.toLowerCase());
                createdSuppliers++;
            }
            return { createdLocations, createdSuppliers, skippedSuppliers };
        });
        log.info("Seed complete:", result);
    } finally {
        await db.close();
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        Deno.exit(1);
    }
}
