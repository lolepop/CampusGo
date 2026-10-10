import pkg from 'npm:@prisma/client';
const { PrismaClient } = pkg;

const prisma = new PrismaClient()

async function main() {
  await prisma.order.create({
    data: {
      requesterId: 'user-222',
      pickupLocation: 'The Terrace@COM3',
      dropoffLocation: 'Foyer@PGP',
      itemDescription: 'Black gaming laptop',
      creditBounty: 5,
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), 
    },
  });

  await prisma.order.create({
    data: {
      requesterId: 'user-333',
      courierId: 'user-111', 
      pickupLocation: 'PGP',
      dropoffLocation: 'COM2',
      itemDescription: 'Library books',
      creditBounty: 3,
      status: 'ACCEPTED',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    },
  });

  await prisma.order.create({
    data: {
      requesterId: 'user-444',
      pickupLocation: 'UTown Starbucks',
      dropoffLocation: 'Tembusu College',
      itemDescription: 'Iced Americano & Croissant',
      creditBounty: 2,
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 2), // Expires in 2 hrs
    },
  });

  await prisma.order.create({
    data: {
      requesterId: 'user-555',
      pickupLocation: 'PC Commons',
      dropoffLocation: 'COM1 Level 2',
      itemDescription: 'Printed CS3230 Assignment',
      creditBounty: 1,
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 5),
    },
  });

  await prisma.order.create({
    data: {
      requesterId: 'user-666',
      courierId: 'user-222',
      pickupLocation: 'Fine Food@Cinnamon',
      dropoffLocation: 'Eusoff Hall',
      itemDescription: 'Chicken Rice (Chilli on the side)',
      creditBounty: 3,
      status: 'ACCEPTED',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 1),
    },
  });

  await prisma.order.create({
    data: {
      requesterId: 'user-777',
      pickupLocation: 'Central Library Level 4',
      dropoffLocation: 'YIH Study Room',
      itemDescription: 'MacBook USB-C Charger',
      creditBounty: 4,
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    },
  });

  await prisma.order.create({
    data: {
      requesterId: 'user-888',
      courierId: 'user-333',
      pickupLocation: 'Kent Ridge MRT Station',
      dropoffLocation: 'UHC',
      itemDescription: 'Left behind blue umbrella',
      creditBounty: 2,
      status: 'ACCEPTED',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 12),
    },
  });

  await prisma.order.create({
    data: {
      requesterId: 'user-999',
      pickupLocation: 'FASS Deck',
      dropoffLocation: 'COM2 SR3',
      itemDescription: 'Group project poster boards',
      creditBounty: 5,
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    },
  });

  await prisma.order.create({
    data: {
      requesterId: 'user-123',
      pickupLocation: 'USC',
      dropoffLocation: 'Raffles Hall',
      itemDescription: 'Gym towel and water bottle',
      creditBounty: 2,
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 4),
    },
  });

  await prisma.order.create({
    data: {
      requesterId: 'user-456',
      courierId: 'user-777',
      pickupLocation: 'Watsons@UTown',
      dropoffLocation: 'PGP House',
      itemDescription: 'Panadol and Cough Syrup',
      creditBounty: 6,
      status: 'ACCEPTED',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 2),
    },
  });

  await prisma.order.create({
    data: {
      requesterId: 'user-789',
      pickupLocation: 'Gong Cha@UTown',
      dropoffLocation: 'Sheares Hall',
      itemDescription: 'Pearl Milk Tea (0% Sugar)',
      creditBounty: 3,
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 1),
    },
  });

  await prisma.order.create({
    data: {
      requesterId: 'user-321',
      pickupLocation: 'Frontier Canteen',
      dropoffLocation: 'King Edward VII Hall',
      itemDescription: 'Leftover jacket',
      creditBounty: 4,
      status: 'CREATED',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 48),
    },
  });

  console.log('Database seeded with dummy orders for UI testing.');
}

main()
  .catch((e) => console.error(e))
  .finally(async () => await prisma.$disconnect());