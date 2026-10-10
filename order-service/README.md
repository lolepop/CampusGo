# Order Service - Local Setup Guide

This guide covers everything required to spin up the Order Service database, seed it with dummy errand data, and test the initial API routes locally.

## 1. Envronment Setup
Create a `.env` file inside the `order-service` folder and add the local database connection string:
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5434/order_db?schema=public"
```

## 2. Boot the Database
Open a terminal at the root of the project ('CampusGo' or the main folder containing compose.yml) and start the the isolated PostgreSQL container for the Order Service:
```docker compose --profile dev up -d order-db```

## 3. Sync Schema & Seed Data
Navigate into Order Srvice folder:
```cd order-service```

Sync the Prisma schema to the newly created database and generate the client:
```deno run -A --env npm:prisma@5 db push```

Seed the databse with dummy UI testing data:
```deno run -A --env src/prisma/seed.ts```

## 4. Start the Development Server
Ensure you are still in the order-service directory, then boot API:
```deno run -A --env --watch src/server.ts``` or ```deno task dev```



## API Testing Guide
-----------------

Fetch All Orders (GET)
- Method: GET
- URL: http://localhost:8000/orders
- Result: should return an array of seeded dummy orders for frontend display

Create a New Order (POST)
- Method: POST
- URL: http://localhost:8000/orders
- Headers: Must include "Idempotency-Key" with a unique string (e.g., "test-req-123") for deduplication.
- Body: (JSON)
    Sample:
        {
          "requesterId": "user-101",
          "pickupLocation": "The Terrace@COM3",
          "dropoffLocation": "Foyer@PGP",
          "itemDescription": "Black gaming laptop",
          "creditBounty": 50,
          "supplierId": null
        }
- Result: Returns a 201 Created status with the newly generated errand, including its auto-assigned UUID and enforced CREATED status. If sent a second time with the exact same Idempotency-Key header, it will safely return a 200 OK with "deduplicated": true instead of double-charging.

Update Order Status (PATCH)
- Method: PATCH
- URL: http://localhost:8000/orders/:id/status (Replace :id with an actual UUID from the GET request)
- Body: (JSON)
    Sample:
        {
          "targetStatus": "ACCEPTED",
          "callerId": "courier-user-202"
        }
- Result: Returns a 200 OK with the newly updated state. The internal state machine enforces access rules: returns 409 Conflict if attempting to accept an already accepted order, 403 Forbidden if the requester attempts to accept their own order, and 403 Forbidden if anyone but the requester attempts to mark the order as COMPLETED.