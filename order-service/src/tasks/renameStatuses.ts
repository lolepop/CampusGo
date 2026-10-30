import log from "../log.ts";
// Converts orders saved before the status rename (CREATED -> OPEN, PICKED_UP -> COLLECTED,
// COMPLETED -> DELIVERED). Runs before `db update` in db:update_dev, because the old status
// check constraint rejects the new names and the new one rejects the old names: this drops
// the check, rewrites the rows, and `db update` then adds the new check back.
// Does nothing on a fresh database or once every row uses the new names, so it is safe to
// run on every start; it can be deleted once everyone's database has been converted.
import { db } from "../prisma/db.ts";

const plan = db.raw.sql`
    DO $$
    DECLARE c record;
    BEGIN
        -- separate checks: the second one cannot even be planned until the table exists
        IF to_regclass('public.orders') IS NULL THEN
            RETURN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM orders WHERE status IN ('CREATED', 'PICKED_UP', 'COMPLETED')) THEN
            RETURN;
        END IF;

        FOR c IN
            SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.orders'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%status%'
        LOOP
            EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', c.conname);
        END LOOP;

        UPDATE orders SET status = CASE status
            WHEN 'CREATED' THEN 'OPEN'
            WHEN 'PICKED_UP' THEN 'COLLECTED'
            WHEN 'COMPLETED' THEN 'DELIVERED'
            ELSE status
        END;
        ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'OPEN';
    END $$
`.returnsRow({}).build();

if (import.meta.main) {
    await db.runtime().query(plan);
    log.info("Order statuses use the current names.");
    await db.close?.();
}
