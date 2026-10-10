import { handleGetOrders, handleCreateOrder, handleUpdateOrderStatus } from "./routes/orders.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // GET /orders
  if (req.method === "GET" && url.pathname === "/orders") {
    return await handleGetOrders(req);
  }

  // POST /orders
  if (req.method === "POST" && url.pathname === "/orders") {
    return await handleCreateOrder(req);
  }

  // PATCH /orders/:id/status
  const statusMatch = url.pathname.match(/^\/orders\/([^/]+)\/status$/);
  if (req.method === "PATCH" && statusMatch) {
    const orderId = statusMatch[1];
    return await handleUpdateOrderStatus(req, orderId);
  }

  // 404 Fallback
  return new Response("Endpoint Not Found", { status: 404 });
});

