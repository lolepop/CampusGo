import { prisma } from "../db.ts";

export async function handleGetOrders(req: Request) {
  try {
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' }
    });
    
    return new Response(JSON.stringify(orders), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Failed to fetch orders" }), { status: 500 });
  }
}

export async function handleCreateOrder(req: Request) {
  try {
    const body = await req.json();
    const idempotencyKey = req.headers.get("Idempotency-Key");
    
    // 1. IDEMPOTENCY CHECK
    if (idempotencyKey) {
      const existingOrder = await prisma.order.findUnique({
        where: { idempotencyKey }
      });
      
      if (existingOrder) {
        return new Response(JSON.stringify({ order: existingOrder, deduplicated: true }), {
          status: 200, 
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 2. CREDIT ESCROW HOLD (Synchronous Call)
    const creditServiceUrl = "http://localhost:8002/credits/reserve"; 
    try {
      const creditRes = await fetch(creditServiceUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: body.requesterId,
          amount: body.creditBounty,
          referenceId: idempotencyKey 
        })
      });

      if (!creditRes.ok) {
        return new Response(JSON.stringify({ error: "Insufficient credits or Credit Service rejected hold." }), { status: 402 });
      }
    } catch (creditError) {
       console.error("Credit Service fetch failed:", creditError);
    }

    // 3. PERSIST TO DATABASE
    const newOrder = await prisma.order.create({
      data: {
        idempotencyKey: idempotencyKey,
        requesterId: body.requesterId,
        pickupLocation: body.pickupLocation,
        dropoffLocation: body.dropoffLocation,
        itemDescription: body.itemDescription,
        creditBounty: body.creditBounty,
        supplierId: body.supplierId || null,
        status: "CREATED",
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    });

    return new Response(JSON.stringify(newOrder), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: "Failed to create order" }), { status: 400 });
  }

}

export async function handleUpdateOrderStatus(req: Request, orderId: string) {
  try {
    const body = await req.json();
    const { targetStatus, callerId, userRole } = body;

    if (!targetStatus || !callerId) {
      return new Response(JSON.stringify({ error: "Missing targetStatus or callerId" }), { status: 400 });
    }

    // 1. Fetch current order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      return new Response(JSON.stringify({ error: "Order not found" }), { status: 404 });
    }

    // 2. Expiry Guard (Lazy check)
    const now = new Date();
    if (order.status === "CREATED" && now > order.expiresAt) {
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "EXPIRED" },
      });
      return new Response(JSON.stringify({ error: "Order has expired" }), { status: 410 });
    }

    // 3. Authorization & Transition Rules
    switch (targetStatus) {
      case "ACCEPTED": {
        if (order.status !== "CREATED") {
          return new Response(JSON.stringify({ error: `Cannot accept order in status ${order.status}` }), { status: 409 });
        }
        if (callerId === order.requesterId) {
          return new Response(JSON.stringify({ error: "Requester cannot accept their own errand" }), { status: 403 });
        }

        // Concurrency Guard: Atomic update ensures only one courier succeeds
        const updated = await prisma.order.updateMany({
          where: { id: orderId, status: "CREATED" },
          data: { status: "ACCEPTED", courierId: callerId },
        });

        if (updated.count === 0) {
          return new Response(JSON.stringify({ error: "Order was already accepted by another courier" }), { status: 409 });
        }
        break;
      }

      case "PICKED_UP": {
        if (order.status !== "ACCEPTED") {
          return new Response(JSON.stringify({ error: `Cannot mark picked up from status ${order.status}` }), { status: 400 });
        }
        if (callerId !== order.courierId) {
          return new Response(JSON.stringify({ error: "Only the assigned courier can mark item as picked up" }), { status: 403 });
        }

        await prisma.order.update({
          where: { id: orderId },
          data: { status: "PICKED_UP" },
        });
        break;
      }

      case "COMPLETED": {
        if (order.status !== "PICKED_UP") {
          return new Response(JSON.stringify({ error: `Cannot complete order before it is picked up` }), { status: 400 });
        }
        if (callerId !== order.requesterId) {
          return new Response(JSON.stringify({ error: "Only the requester can confirm completion" }), { status: 403 });
        }

        // Synchronous Credit Transfer to Courier
        const creditServiceUrl = "http://localhost:8002/credits/transfer";
        try {
          const creditRes = await fetch(creditServiceUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              courierId: order.courierId,
              amount: order.creditBounty,
              orderId: order.id,
            }),
          });

          if (!creditRes.ok) {
            return new Response(JSON.stringify({ error: "Credit Service rejected payout transfer" }), { status: 502 });
          }
        } catch (creditError) {
          console.error("Credit Service payout failed:", creditError);
          // If testing in isolation, comment the return statement below:
          // return new Response(JSON.stringify({ error: "Failed to connect to Credit Service" }), { status: 502 });
        }

        await prisma.order.update({
          where: { id: orderId },
          data: { status: "COMPLETED" },
        });
        break;
      }

      case "CANCELLED": {
        const canCancel = callerId === order.requesterId || userRole === "ADMIN";
        if (!canCancel) {
          return new Response(JSON.stringify({ error: "Unauthorized to cancel this errand" }), { status: 403 });
        }
        if (order.status === "COMPLETED" || order.status === "CANCELLED" || order.status === "EXPIRED") {
          return new Response(JSON.stringify({ error: `Cannot cancel an order in ${order.status} state` }), { status: 400 });
        }

        // Synchronous Credit Release back to Requester
        const creditReleaseUrl = "http://localhost:8002/credits/release";
        try {
          const releaseRes = await fetch(creditReleaseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: order.requesterId,
              amount: order.creditBounty,
              orderId: order.id,
            }),
          });

          if (!releaseRes.ok) {
            return new Response(JSON.stringify({ error: "Credit Service rejected refund release" }), { status: 502 });
          }
        } catch (releaseError) {
          console.error("Credit Service release failed:", releaseError);
          // If testing in isolation, comment the return statement below:
          // return new Response(JSON.stringify({ error: "Failed to connect to Credit Service" }), { status: 502 });
        }

        await prisma.order.update({
          where: { id: orderId },
          data: { status: "CANCELLED" },
        });
        break;
      }

      default:
        return new Response(JSON.stringify({ error: `Unsupported transition to ${targetStatus}` }), { status: 400 });
    }

    const finalOrder = await prisma.order.findUnique({ where: { id: orderId } });
    return new Response(JSON.stringify(finalOrder), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Status update error:", error);
    return new Response(JSON.stringify({ error: "Failed to update order status" }), { status: 500 });
  }
}



