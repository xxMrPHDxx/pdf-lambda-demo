import { createHash } from "node:crypto";
import type { Catalog, Client, Order, OrderItem, OrderStatus } from "./types";

interface Product {
  sku: string;
  description: string;
  unitPrice: number;
}

const CLIENTS: Client[] = [
  { id: "acme", name: "Acme Retail", email: "ops@acme.test", initials: "AR" },
  { id: "globex", name: "Globex Corp", email: "ops@globex.test", initials: "GC" },
  { id: "initech", name: "Initech Labs", email: "ops@initech.test", initials: "IL" },
  { id: "umbrella", name: "Umbrella Co", email: "ops@umbrella.test", initials: "UC" },
  { id: "stark", name: "Stark Supply", email: "ops@stark.test", initials: "SS" },
  { id: "wayne", name: "Wayne Works", email: "ops@wayne.test", initials: "WW" },
];

const SUPPLIER_PRODUCTS: Record<string, Product[]> = {
  "Nordic Paper Co": [
    { sku: "NP-A4-80", description: "A4 Copy Paper 80gsm", unitPrice: 4.25 },
    { sku: "NP-A5-NB", description: "A5 Recycled Notebook", unitPrice: 8.1 },
    { sku: "NP-ENV-K", description: "Kraft Envelopes (pack of 50)", unitPrice: 6.65 },
    { sku: "NP-BOX-A", description: "Archive Box with Lid", unitPrice: 3.4 },
  ],
  "Atlas Industrial": [
    { sku: "AT-GLV-N", description: "Nitrile Gloves (box of 100)", unitPrice: 12.5 },
    { sku: "AT-GOG-S", description: "Safety Goggles, anti-fog", unitPrice: 18.75 },
    { sku: "AT-TAPE-P", description: "Packing Tape 48mm", unitPrice: 2.2 },
    { sku: "AT-CUT-1", description: "Retractable Box Cutter", unitPrice: 7.9 },
  ],
  "Verdant Supply": [
    { sku: "VD-TIS-R", description: "Recycled Facial Tissue (12)", unitPrice: 6.4 },
    { sku: "VD-CLN-E", description: "Eco Surface Cleaner 1L", unitPrice: 9.25 },
    { sku: "VD-LIN-C", description: "Compostable Liners (roll)", unitPrice: 11.0 },
    { sku: "VD-MOP-H", description: "Microfibre Mop Head", unitPrice: 5.5 },
  ],
  "Helios Electronics": [
    { sku: "HX-USBC-2", description: "USB-C Braided Cable 2m", unitPrice: 9.99 },
    { sku: "HX-LBL-1", description: "Desktop Label Printer", unitPrice: 89.0 },
    { sku: "HX-SCAN-2", description: "Barcode Scanner, wireless", unitPrice: 129.5 },
    { sku: "HX-LBL-500", description: "Thermal Labels (500 pack)", unitPrice: 24.75 },
  ],
};

const SUPPLIER_NAMES = Object.keys(SUPPLIER_PRODUCTS);
const STATUSES: OrderStatus[] = ["confirmed", "paid", "packing", "shipped"];

const CUSTOMERS = [
  "Mira Chen",
  "Tomas Novak",
  "Sana Rahman",
  "Jules Weber",
  "Priya Nair",
  "Elena Rossi",
  "Noah Fischer",
  "Amara Okafor",
  "Leo Martins",
  "Yuki Tanaka",
  "Ines Duarte",
  "Owen Clarke",
  "Hannah Berg",
  "Rafael Costa",
  "Aisha Bello",
  "Marek Kowalski",
];

const STREETS = [
  "12 Analytical Way",
  "48 Foundry Lane",
  "7 Orchard Crescent",
  "221 Harbour Road",
  "19 Linden Street",
  "3 Meridian Court",
  "86 Chapel Walk",
  "14 Somerset Row",
];

const CITIES = ["London", "Rotterdam", "Lisbon", "Chicago", "Toronto", "Berlin", "Oslo", "Austin"];

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(items: T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)];
}

const ORDER_COUNTS: Record<string, number> = {
  acme: 18,
  globex: 14,
  initech: 12,
  umbrella: 10,
  stark: 10,
  wayne: 10,
};
const ID_PREFIX: Record<string, string> = {
  acme: "AC",
  globex: "GX",
  initech: "IN",
  umbrella: "UM",
  stark: "ST",
  wayne: "WW",
};

export function createSeedCatalog(): Catalog {
  const rand = makeRandom(20261027);
  const orders: Order[] = [];

  CLIENTS.forEach((client, clientIndex) => {
    const count = ORDER_COUNTS[client.id] ?? 12;
    for (let i = 0; i < count; i++) {
      const primarySupplier = SUPPLIER_NAMES[(i + clientIndex) % SUPPLIER_NAMES.length];
      const suppliers = [primarySupplier];
      if (rand() > 0.55) {
        const other = pick(
          SUPPLIER_NAMES.filter((name) => name !== primarySupplier),
          rand,
        );
        suppliers.push(other);
      }
      if (rand() > 0.85) {
        const third = pick(
          SUPPLIER_NAMES.filter((name) => !suppliers.includes(name)),
          rand,
        );
        suppliers.push(third);
      }

      const items: OrderItem[] = [];
      const used = new Set<string>();
      for (const supplier of suppliers) {
        const productList = SUPPLIER_PRODUCTS[supplier];
        let product = pick(productList, rand);
        let guard = 0;
        while (used.has(product.sku) && guard < productList.length) {
          product = productList[(productList.indexOf(product) + 1) % productList.length];
          guard++;
        }
        used.add(product.sku);
        items.push({
          sku: product.sku,
          description: product.description,
          qty: 1 + Math.floor(rand() * 24),
          unitPrice: product.unitPrice,
          supplier,
        });
      }

      const customerName = CUSTOMERS[(clientIndex * 7 + i) % CUSTOMERS.length];
      const address = `${pick(STREETS, rand)}, ${pick(CITIES, rand)}`;
      const placed = new Date(Date.UTC(2026, 8, 1 + i * 2, 9, 30)).toISOString();
      orders.push({
        id: `${ID_PREFIX[client.id]}-${1000 + clientIndex * 1000 + i + 1}`,
        clientId: client.id,
        rev: 1 + ((i + clientIndex * 2) % 4),
        status: STATUSES[(i + clientIndex) % STATUSES.length],
        currency: "USD",
        placedAt: placed,
        customer: {
          name: customerName,
          email: `${customerName.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
          address,
        },
        items,
      });
    }
  });

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    clients: CLIENTS,
    orders,
  };
}

export function supplierNames(): string[] {
  return [...SUPPLIER_NAMES].sort();
}

export function supplierNamesForOrder(order: Order): string[] {
  return [...new Set(order.items.map((item) => item.supplier))].sort();
}

export function documentCount(order: Order): number {
  return supplierNamesForOrder(order).length;
}

export function orderSignature(order: Order): string {
  const items = [...order.items]
    .sort((a, b) => (a.sku === b.sku ? a.description.localeCompare(b.description) : a.sku.localeCompare(b.sku)))
    .map((item) => [item.sku, item.description, item.qty, item.unitPrice.toFixed(4), item.supplier]);
  const contentHash = createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 16);
  return `${order.id}|${order.rev}|${order.status}|${contentHash}`;
}

export function filterHashForOrders(orders: Order[]): string {
  const signatures = orders.map(orderSignature).sort();
  return createHash("sha256").update(signatures.join("\n")).digest("hex").slice(0, 24);
}

export function allClients(): Client[] {
  return CLIENTS.map((client) => ({ ...client }));
}
