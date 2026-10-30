import { isExpectedDbError, recordError } from "../telemetry/tracing.ts";
import log from "../log.ts";
import { withDatabaseOperation } from "../telemetry/database.ts";
// import type { Context, RouterContext } from "@oak/oak";
// import { z } from "zod";
// import type { ISupplierRepository } from "../prisma/suppliers.ts";
// import { ErrorType, SupplierError } from "../prisma/common.ts";
// import { SupplierType } from "../common.ts";
// import { checkCrossFieldRules, type SupplierFields, supplierFieldSchemas } from "../util/supplierRules.ts";
// import type { IOrderServiceClient } from "../util/orderService.ts";
// import type { AuthenticatedUser } from "../middleware/auth.ts";
// import config from "../config.ts";
// import log from "../log.ts";

// const { defaultPageSize, maxPageSize, maxSearchLength } = config.supplier;

// // query strings are always text, so coerce and validate here
// export const listSuppliersQuerySchema = z.object({
//     q: z.string().trim().max(maxSearchLength).optional(),
//     // comma separated, e.g. type=food,coffee
//     type: z.string()
//         .transform(s => s.split(",").map(t => t.trim()).filter(t => t.length > 0))
//         .pipe(z.array(z.enum(SupplierType)))
//         .optional(),
//     openNow: z.enum(["true", "false"]).transform(v => v === "true").optional(),
//     locationId: z.coerce.number().int().positive().optional(),
//     sort: z.enum(["name", "-name"]).default("name"),
//     page: z.coerce.number().int().min(1).default(1),
//     pageSize: z.coerce.number().int().min(1).max(maxPageSize).default(defaultPageSize),
// }).strict();

// export type ListSuppliersQuery = z.infer<typeof listSuppliersQuerySchema>;

// export const supplierIdSchema = z.coerce.number().int().positive();

// const { name, type, description, locationId, openingHours } = supplierFieldSchemas;

// export const createSupplierSchema = z.object({
//     name,
//     type,
//     description: description.default(null),
//     locationId: locationId.default(null),
//     openingHours: openingHours.default(null),
// }).strict().superRefine((s, ctx) => {
//     for (const [field, messages] of Object.entries(checkCrossFieldRules(s))) {
//         for (const message of messages)
//             ctx.addIssue({ code: "custom", path: [field], message });
//     }
// });

// // every field optional; rules spanning fields are checked against the stored supplier
// export const updateSupplierSchema = z.object({
//     name: name.optional(),
//     type: type.optional(),
//     description: description.optional(),
//     locationId: locationId.optional(),
//     openingHours: openingHours.optional(),
// }).strict().refine(p => Object.keys(p).length > 0, "Nothing to update");

// const internalError = (ctx: Context, e: unknown) => {
//     log.error(`supplier request failed: ${e} (origin: ${(<Error>e)?.stack})`);
//     ctx.response.status = 500;
//     ctx.response.body = { error: "unknown error" };
// };

// const statusOf: Record<ErrorType, number> = {
//     [ErrorType.Invalid]: 400,
//     [ErrorType.NotFound]: 404,
//     [ErrorType.Conflict]: 409,
// };

// const applyError = (ctx: Context, e: unknown) => {
//     if (e instanceof SupplierError) {
//         ctx.response.status = statusOf[e.type];
//         ctx.response.body = e.fields ? { error: e.message, fields: e.fields } : { error: e.message };
//         return;
//     }
//     internalError(ctx, e);
// };

// const parseId = (ctx: RouterContext<"/:id">): number | null => {
//     const id = supplierIdSchema.safeParse(ctx.params.id);
//     if (id.success)
//         return id.data;
//     ctx.response.status = 400;
//     ctx.response.body = { error: "supplier id must be a positive integer" };
//     return null;
// };

// const actorOf = (ctx: Context) => (<AuthenticatedUser>ctx.state.user).id;

// export class SupplierController {
//     supplierRepo: ISupplierRepository;
//     orderService: IOrderServiceClient;

//     constructor(supplierRepo: ISupplierRepository, orderService: IOrderServiceClient) {
//         this.supplierRepo = supplierRepo;
//         this.orderService = orderService;
//     }

//     /**
//      * Admin-only: create a supplier, responds with the created supplier
//      */
//     async createSupplier(ctx: RouterContext<"/">) {
//         const fields = <SupplierFields>ctx.state.validatedBody;
//         try {
//             const id = await this.supplierRepo.createSupplier(fields, actorOf(ctx));
//             ctx.response.status = 201;
//             ctx.response.headers.set("Location", `${ctx.request.url.pathname.replace(/\/$/, "")}/${id}`);
//             ctx.response.body = await this.supplierRepo.findSupplierById(id);
//         } catch (e) {
//             applyError(ctx, e);
//         }
//     }

//     /**
//      * Admin-only: change some fields of a supplier, responds with the updated supplier
//      */
//     async updateSupplier(ctx: RouterContext<"/:id">) {
//         const id = parseId(ctx);
//         if (id === null)
//             return;
//         const patch = <Partial<SupplierFields>>ctx.state.validatedBody;
//         try {
//             await this.supplierRepo.updateSupplier(id, patch, actorOf(ctx));
//             ctx.response.body = await this.supplierRepo.findSupplierById(id);
//         } catch (e) {
//             applyError(ctx, e);
//         }
//     }

//     /**
//      * Admin-only: soft delete a supplier
//      */
//     async deleteSupplier(ctx: RouterContext<"/:id">) {
//         const id = parseId(ctx);
//         if (id === null)
//             return;
//         try {
//             const deletedIds = await this.supplierRepo.deleteSupplier(id, actorOf(ctx), async ids =>
//                 await this.orderService.hasOngoingErrands(ids)
//                     ? "an errand for this supplier is still ongoing, try again once it has finished"
//                     : null
//             );
//             ctx.response.body = { deletedIds };
//         } catch (e) {
//             applyError(ctx, e);
//         }
//     }

//     /**
//      * Any signed-in user: list live suppliers, with optional search, filters, sort and pagination
//      */
//     async listSuppliers(ctx: RouterContext<"/">) {
//         const query = <ListSuppliersQuery>ctx.state.validatedQuery;
//         try {
//             const result = await this.supplierRepo.listSuppliers({
//                 search: query.q || undefined,
//                 types: query.type,
//                 openNow: query.openNow,
//                 locationId: query.locationId,
//                 sortDescending: query.sort === "-name",
//                 page: query.page,
//                 pageSize: query.pageSize,
//             });
//             ctx.response.body = {
//                 ...result,
//                 totalPages: Math.ceil(result.total / result.pageSize),
//             };
//         } catch (e) {
//             internalError(ctx, e);
//         }
//     }

//     /**
//      * Get one supplier by id. Deleted suppliers are only visible to other
//      * services through the private router, e.g. for past errands
//      */
//     async getSupplier(ctx: RouterContext<"/:id">, includeDeleted = false) {
//         const id = supplierIdSchema.safeParse(ctx.params.id);
//         if (!id.success) {
//             ctx.response.status = 400;
//             ctx.response.body = { error: "supplier id must be a positive integer" };
//             return;
//         }
//         try {
//             const supplier = await this.supplierRepo.findSupplierById(id.data, includeDeleted);
//             if (!supplier) {
//                 ctx.response.status = 404;
//                 ctx.response.body = { error: "supplier not found" };
//                 return;
//             }
//             ctx.response.body = supplier;
//         } catch (e) {
//             internalError(ctx, e);
//         }
//     }
// }


import type { Context } from "@oak/oak";
import type { z } from "zod";
import { db } from "../prisma/db.ts";
import type { AuthenticatedUser } from "../middleware/auth.ts";
import { hoursPairedMessage } from "../schema/supplier.ts";
import type { createSupplierSchema, ListSuppliersQuery, updateSupplierSchema } from "../schema/supplier.ts";

export const fetchAllSuppliers = async (ctx: Context) => {
    // name, locationid, sortby, sortorder, page 
    
    const query = ctx.state.validatedQuery as ListSuppliersQuery;
    const limit = 20;
    const offset = (query.page - 1) * limit

    try {
        // filter out deleted suppliers
        let supplierQuery = db.orm.public.Supplier
            .where({ deletedAt: null });

        // filter by locationId(if specified)
        if (query.locationId !== undefined) {
            supplierQuery = supplierQuery
                .where({ locationId: query.locationId })
        }

        // filter by supplier name(if specified)
        if (query.name !== undefined) {
            supplierQuery = supplierQuery.where(
                supplier => supplier.name.ilike(`%${query.name}%`)
            );
        }

        // count total suppliers
        const { total } = await withDatabaseOperation("database.Supplier.aggregate", async () => supplierQuery.aggregate(agg => ({
            total: agg.count(),
        })));

        // determine if sort by name or id, asc or desc, then sort accordingly, applying offset and limit
        const suppliers = await withDatabaseOperation("database.Supplier.all", async () => supplierQuery
            .orderBy(supplier => {
            let field;
            if (query.sortBy === "name" ) {
                field = supplier.name
            } else {
                field = supplier.id;
            } 
            return query.sortOrder === "asc" ? field.asc() : field.desc()})
            .offset(offset)
            .limit(limit)
            .all());

        ctx.response.status = 200;
        ctx.response.body = {
            data: suppliers,
            pagination: {
                page: query.page,
                limit,
                total, 
                totalPage: Math.ceil(total / limit)
            },
        };
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        ctx.response.status = 500;
    }
}

export const fetchSupplier = async (ctx: Context, id: number) => {

    // check if id is a positive int
    if (!Number.isInteger(id) || id <= 0) {
        ctx.response.status = 400;
        ctx.response.body = {
            error: "Supplier ID must be a positive integer"
        }
        return;
    }

    try {
        const supplier = await withDatabaseOperation("database.Supplier.first", async () => db.orm.public.Supplier
            .where({ id: id })
            .first());

        // check if supplier record doesn't exist/has been soft-deleted
        if (!supplier || supplier.deletedAt !== null) {
            ctx.response.status = 404
            ctx.response.body = {
                error: "Supplier with specified ID not found"
            }
            return;
        }

        ctx.response.status = 200;
        ctx.response.body = supplier;
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        log.error("Failed to fetch supplier:", error);
        ctx.response.status = 500;
        ctx.response.body = { 
            error: "Internal server error" 
        }
    }
}

// responds like validateBody, naming the field at fault so the form can show it
const rejectField = (ctx: Context, status: 400 | 409, field: string, message: string) => {
    ctx.response.status = status;
    ctx.response.body = {
        error: "invalid supplier",
        fields: { [field]: [message] }
    }
}

// deleted locations can no longer be given to suppliers
const locationExists = async (locationId: number) =>
    Boolean(await withDatabaseOperation("database.Location.first", async () => db.orm.public.Location.where({ id: locationId, deletedAt: null }).first()));

/**
 * Names are unique across all suppliers, including soft-deleted ones.
 * Returns why the name can't be used, or null if it is free
 */
const nameConflict = async (name: string, exceptId?: number): Promise<string | null> => {
    const existing = await withDatabaseOperation("database.Supplier.first", async () => db.orm.public.Supplier.where({ name: name }).first());
    if (!existing || existing.id === exceptId)
        return null;
    return existing.deletedAt === null
        ? `"${name}" is already used by another supplier`
        : `"${name}" belongs to a deleted supplier, choose another name`;
}

export const createSupplier = async (ctx: Context) => {

    // get validatedBody, returned from validateBody(schema) in routes
    const body = <z.infer<typeof createSupplierSchema>>ctx.state.validatedBody;
    const actorUserId = (<AuthenticatedUser>ctx.state.user).id;

    try {
        if (!await locationExists(body.locationId)) {
            rejectField(ctx, 400, "locationId", "Building not found");
            return;
        }
        const conflict = await nameConflict(body.name);
        if (conflict) {
            rejectField(ctx, 409, "name", conflict);
            return;
        }

        const created = await withDatabaseOperation("database.Supplier.create", async () => db.orm.public.Supplier.create({
            name: body.name,
            type: body.type,
            locationId: body.locationId,
            floor: body.floor ?? null,
            imageUrl: body.imageUrl ?? null,
            description: body.description || null,
            opensAt: body.opensAt ?? null,
            closesAt: body.closesAt ?? null,
            createdBy: actorUserId,
            updatedBy: actorUserId,
        }))
        ctx.response.status = 201;
        ctx.response.body = created;
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        log.error("Failed to create supplier:", error);
        ctx.response.status = 500;
        ctx.response.body = {
            error: "Internal server error"
        }
    }
}

export const updateSupplier = async (ctx: Context, id: number) => {
    // check if id is a positive int
    if (!Number.isInteger(id) || id <= 0) {
        ctx.response.status = 400;
        ctx.response.body = {
            error: "Supplier ID must be a positive integer"
        }
        return;
    }

    // only the fields being changed, returned from validateBody(schema) in routes
    const patch = <z.infer<typeof updateSupplierSchema>>ctx.state.validatedBody;
    const actorUserId = (<AuthenticatedUser>ctx.state.user).id;

    try {
        const supplier = await withDatabaseOperation("database.Supplier.first", async () => db.orm.public.Supplier
            .where({ id: id })
            .first());

        // check if supplier doesn't exist/has been soft-deleted
        if (!supplier || supplier.deletedAt !== null) {
            ctx.response.status = 404;
            ctx.response.body = {
                error: "Supplier with specified ID not found"
            }
            return;
        }

        // hours must stay paired once the patch is applied to the stored supplier
        const opensAt = patch.opensAt !== undefined ? patch.opensAt : supplier.opensAt;
        const closesAt = patch.closesAt !== undefined ? patch.closesAt : supplier.closesAt;
        if ((opensAt === null) !== (closesAt === null)) {
            rejectField(ctx, 400, "closesAt", hoursPairedMessage);
            return;
        }
        if (patch.locationId !== undefined && !await locationExists(patch.locationId)) {
            rejectField(ctx, 400, "locationId", "Building not found");
            return;
        }
        if (patch.name !== undefined) {
            const conflict = await nameConflict(patch.name, id);
            if (conflict) {
                rejectField(ctx, 409, "name", conflict);
                return;
            }
        }

        await withDatabaseOperation("database.Supplier.update", async () => db.orm.public.Supplier
            .where({ id: id })
            .update({
                ...patch,
                // blank description is stored as null
                ...(patch.description !== undefined ? { description: patch.description || null } : {}),
                updatedAt: new Date().toISOString(),
                updatedBy: actorUserId,
            }));

        ctx.response.status = 200;
        ctx.response.body = await withDatabaseOperation("database.Supplier.first", async () => db.orm.public.Supplier
            .where({ id: id })
            .first());
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        log.error("Failed to update supplier:", error);
        ctx.response.status = 500;
        ctx.response.body = {
            error: "Internal server error"
        }
    }
}

export const deleteSupplier = async (ctx: Context, id: number) => {
    // check if id is a positive int
    if (!Number.isInteger(id) || id <= 0) {
        ctx.response.status = 400;
        ctx.response.body = {
            error: "Supplier ID must be a positive integer"
        }
        return;
    }

    try {
        const supplier = await withDatabaseOperation("database.Supplier.first", async () => db.orm.public.Supplier
            .where({ id: id })
            .first())

        // check if supplier doesn't exist/has been soft-deleted
        if (!supplier || supplier.deletedAt !== null) {
            ctx.response.status = 404;
            ctx.response.body = {
                error: "Supplier with specified ID not found"
            }
            return;
        }
        const now = new Date().toISOString();

        const actorUserId = (<AuthenticatedUser>ctx.state.user).id;
        await withDatabaseOperation("database.Supplier.update", async () => db.orm.public.Supplier
            .where({ id: id })
            .update({
                deletedAt: now,
                updatedAt: now,
                updatedBy: actorUserId
            }));

            ctx.response.status = 204;
    } catch (error) {
        if (!isExpectedDbError(error)) recordError(error);
        log.error("Failed to delete supplier:", error);
        ctx.response.status = 500;
        ctx.response.body = {
            error: "Internal server error"
        }
    }
}
