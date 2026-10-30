import { isExpectedDbError, recordError } from "../telemetry/tracing.ts";
import { withDatabaseOperation } from "../telemetry/database.ts";
import type { Context } from "@oak/oak";
import { db } from "../prisma/db.ts";

export const fetchAllLocations = async (ctx: Context) => {
    try {
        const locations = await withDatabaseOperation("database.Location.all", async () => db.orm.public.Location
            .where({ deletedAt: null })
            .orderBy(location => location.name.asc())
            .all())
        ctx.response.status = 200;
        ctx.response.body = locations;
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        ctx.response.status = 500;
    }
}

export const createLocation = async (ctx: Context) => {

    // get validatedBody, returned from validateBody(schema) in routes
    const body = ctx.state.validatedBody

    try {
        const location = await withDatabaseOperation("database.Location.create", async () => db.orm.public.Location.create({
            name: body.name,
        }))
        ctx.response.status = 201;
        ctx.response.body = location;
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        ctx.response.status = 409;
    }
}

export const deleteLocation = async (ctx: Context, id: number) => {
    // check if id is a positive int
    if (!Number.isInteger(id) || id <= 0) {
        ctx.response.status = 400;
        ctx.response.body = {
            error: "Location ID must be a positive integer"
        }
        return;
    }

    try {
        const location = await withDatabaseOperation("database.Location.first", async () => db.orm.public.Location
            .where({ id: id })
            .first())

        // Check if the location doesn't exist or has been soft-deleted.
        if (!location || location.deletedAt !== null) {
            ctx.response.status = 404;
            ctx.response.body = {
                error: "Location with specified ID not found"
            }
            return;
        }
        // Include soft-deleted suppliers: they still reference this location.
        const associatedSupplier = await withDatabaseOperation("database.Supplier.first", async () => db.orm.public.Supplier
            .where({ locationId: id })
            .first());

        if (associatedSupplier) {
            ctx.response.status = 409;
            ctx.response.body = {
                error: "Cannot delete a location that is associated with suppliers"
            };
            return;
        }

        const now = new Date().toISOString();

        await withDatabaseOperation("database.Location.update", async () => db.orm.public.Location
            .where({ id: id })
            .update({
                deletedAt: now,
            }));

            ctx.response.status = 204;
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        ctx.response.status = 500;
        ctx.response.body = {
            error: "Internal server error"
        }
    }
}
