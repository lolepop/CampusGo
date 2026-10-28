import { meter } from "./instruments.ts";
import { SnapshotMonitor, type SnapshotMonitorOptions } from "./snapshot.ts";

export interface AccountSnapshot {
    notSuspended: number;
    suspended: number;
}

/** Current durable account counts, not distinct active users or a lifetime registration counter. */
export class AccountMetricsMonitor extends SnapshotMonitor<AccountSnapshot> {
    constructor(read: () => Promise<AccountSnapshot>, options: SnapshotMonitorOptions = {}) {
        super("campusgo.user", read, snapshot =>
            [snapshot.notSuspended, snapshot.suspended].every(value => Number.isInteger(value) && value >= 0), options);
        this.observe(meter.createObservableGauge("campusgo.user.accounts"), result => {
            const snapshot = this.getFreshSnapshot();
            if (snapshot) {
                result.observe(snapshot.notSuspended, { state: "not_suspended" });
                result.observe(snapshot.suspended, { state: "suspended" });
            }
        });
    }
}

const authRequests = meter.createCounter("campusgo.user.auth.requests", { unit: "1" });
const authRoutes = new Map([
    ["/public/auth/register", "register"],
    ["/public/auth/login", "login"],
    ["/public/auth/refresh", "refresh"],
]);

/**
 * Called once after Oak produces the final response, including validation rejections.
 * Count only POSTs to known route templates. Outcomes describe HTTP responses, not root causes;
 * no body, credentials, token, user ID, or arbitrary URL becomes a metric dimension.
 */
export function recordAuthResponse(method: string, route: string, status: number): void {
    const operation = authRoutes.get(route);
    if (method !== "POST" || !operation)
        return;
    const outcome = status >= 200 && status < 300 ? "success" :
        status >= 400 && status < 500 ? "rejected" :
        status >= 500 && status < 600 ? "error" : "other";
    authRequests.add(1, { operation, outcome });
}
