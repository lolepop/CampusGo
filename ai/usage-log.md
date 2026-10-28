# 19/9/2026
- Tool used: deepseek chat
- Mode: Generation
- Prompt:
```
create a login page in vuetify + typescript. mock any external calls made. requirements:
- email and password field
- upon error from server, display popup notification/alert
- 2 buttons: login and register
- register slides a form over the existing login form
- register has email and password field. additionally has a password complexity meter (list of what is missing/violated)
- enable client side validation through zod
```
- Prompt:
```
provide a typescript function to nicely format an error message in bulleted form of a similar variant to the following object provided:

{"error":"request schema violation","details":{"errors":[],"properties":{"password":{"errors":["Too big: expected string to have <=128 characters"]}}}}
```
- Output used (login.vue): most of the template and stylesheet was copied. state code was stripped of irrelevant code (mock data), the rest of the styling code was inspected as left intact. the fancy responsive password field was too complicated so it was removed. finally, integration was done by hooking up error handling, login and register apis/stores.
- Output used (zodErrorFormatter.ts): the second prompt was for the formatting of server side validation errors/general errors in the popup notification. the code is somewhat small and looks reasonable, so this was used with little modification.

# 27/9/2026
- Tool used: deepseek chat
- Mode: Generation
- Prompt:
```
given the following sample containing some tests in deno + typescript, write tests for the remainder of the controllers provided.

CONTROLLERS, RELEVANT INTERFACES AND MIDDLEWARE ATTACHED IN CONTEXT

describe("UserController.updateUserRole", () => {
    it("admin can grant admin to another user", async () => {
        const roleRepo  = {
            assignRoles: spy(async () => {}),
            removeRoles: spy(async () => {}),
        };
        const userRepo: Partial<IUserRepository> = {
            // should not care about the value
            getUserByIdPublic: spy(async (_id: number) => ({} as never))
        };
        const userController = new UserController(makeUserRepo(userRepo), makeRoleRepo(roleRepo), {} as never);
        const ctx = new FakeCtx({
            params: { id: "9" },
            jwtPayload: adminPayload,
            validatedBody: { [Role.Admin]: true },
        });

        await userController.updateUserRole(ctx.asCtx());

        assertEquals(ctx.response.body, "updated");
        assertEquals(roleRepo.assignRoles.calls[0].args, [9, new Set([Role.Admin])]);
        assertEquals(roleRepo.removeRoles.calls.length, 0);
    });
    
    ...
});

... MORE MANUALLY WRITTEN TESTS PASSED AS EXAMPLES

// mock password hashing
export function makeHasher(overrides: Partial<IPasswordHash> = {}): IPasswordHash {
    return {
        hashPassword: overrides.hashPassword ?? (async (pw: string) => `hashed:${pw}`),
        verifyPassword: overrides.verifyPassword ?? (async () => true),
    };
}
... REST OF THE MOCK GENERATING UTILITY DEFINITIONS
```
- Output used: tests were selectively picked from the list of generated ones. many were irrelevant and tested external library functionality (they were removed). the accepted ones were manually inspected and manually refactored to be easier to read (lots of duplicate). some additional tests that were missing were added (e.g. a user being able to edit own role)

example of irrelevant tests: the other tests already cover this indirectly by failing if zod rejects them, which is dependent on the scheme
```
it("strips extra fields when schema is strict", async () => {
    const strict = z.object({ name: z.string() }).strict();
    const mw = validateBody(strict);
    const ctx = new FakeCtx({ bodyJson: { name: "hello", extra: true } });
    const next = spy(async () => {});

    await mw(ctx.asCtx(), next);

    // zod strict() rejects unknown keys — so this should 400
    assertEquals(ctx.response.status, 400);
    assertEquals(next.calls.length, 0);
});
```
# 29/9/2026
- Tool used: codex chat
- Mode: Generation
- Prompt:
```
Generate code to help me seed locations from the csv first then proceed to seed the suppliers, follow the format given by the comments given in the contract.prisma
```

# 18/10/2026
- Tool used: codex chat
- Mode: Generation
- Prompt:
```
Generate code so that when a user's credit account is missing, credit-service queries user-service via RPC. If the user exists, create their UserCredits entry without resetting any existing balance. If the user does not exist, retain the existing rejection behavior. Propagate RPC failures so they are not treated as nonexistent users.
```

# 23/10/2026
- Tool used: codex
- Mode: Generation
- Prompt:
```
generate documentation for README.md under user-service. capture the following info:
- first setup requirements (how to generate first admin invite code, exec into container and run the correct deno task)
- small table of api endpoints and what they do (summary)
- mermaidjs db diagram of the prisma schema
- project structure
ensure it is concise
```
- output used: sections were rearranged to have better logical ordering. the tool generated extra items such as a "how to run without containers" section. this was unnecessary, so similar items were removed.

# 26/10/2026
- Tool used: codex
- Mode: Generation
- Prompt:
```
scaffold setup of opentelemetry deno in user service (add env vars to docker compose). it should expose the http/grpc interface and push to a central opentelemetry collector (not present in compose yet)
write a set of hooks to intercept http inbound/outbound requests from oak.
add correlation/trace id to every request made (including handlers for rpc). ensure responses also contain modify the outbox table with a "metadata" column that is sent together with any item to the rabbitmq broker. make sure that correlation id is returned in http requests when generated.
make use of opentelemetry spans to demarcate operations and context like db transactions and broker actions (publish, rpc sent etc.)
```
- output used: most of the hooks provided made sense. i did a scan through and made sure that existing functional/business logic behaviour was not modified. it added a lot of random integration tests (db, queue) which were removed.

- Prompt:
```
create an outbox reliability monitoring worker in user service. updates should occur every 30 seconds. then the metrics poll will automatically pick up the last metric.
we want to measure the following metrics: pending/ready to be sent/delayed (due to temp failure)/fully failed. oldest unsent item. put the code into the telemetry directory and use the existing helpers in it.
```
- output used: the worker generated was acceptable. a welcome addition was that it also introduced some additional metrics like heartbeats to make it known if the worker actually active. this was an improvement, so it was accepted

- Prompt:
```
connect otel-collector to prometheus and prometheus to grafana. the necessary images have already been configured in the docker compose config. place the appropriate config files in /observability. ignore any trace exports for now and focus on metrics alone. ensure that prometheus grabs rabbitmq's exported metrics.
```
