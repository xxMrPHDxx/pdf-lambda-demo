import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { AwsService } from "../aws/aws.service";
import { env } from "../config";
import { allClients, createSeedCatalog, documentCount, filterHashForOrders, supplierNames } from "../seed";
import type { Catalog, Client, Order, OrderStatus, OrderItem } from "../types";

const CATALOG_KEY = "catalog/orders.json";
const STATUSES: OrderStatus[] = ["confirmed", "paid", "packing", "shipped"];
const CACHE_MS = 1500;

@Injectable()
export class CatalogService {
  private cached?: { at: number; catalog: Catalog };
  private loading?: Promise<Catalog>;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly aws: AwsService) {}

  async ensureSeeded(): Promise<void> {
    const exists = await this.objectExists(CATALOG_KEY);
    if (exists) {
      return;
    }
    await this.putCatalog(createSeedCatalog());
  }

  async getCatalog(force = false): Promise<Catalog> {
    if (!force && this.cached && Date.now() - this.cached.at < CACHE_MS) {
      return this.cached.catalog;
    }
    if (this.loading) {
      return this.loading;
    }
    this.loading = this.loadCatalog().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async loadCatalog(): Promise<Catalog> {
    try {
      const result = await this.aws.s3.send(
        new GetObjectCommand({ Bucket: env.bucket, Key: CATALOG_KEY }),
      );
      const body = await result.Body?.transformToString("utf-8");
      if (!body) {
        throw new Error("empty catalog body");
      }
      const catalog = JSON.parse(body) as Catalog;
      this.cached = { at: Date.now(), catalog };
      return catalog;
    } catch (error) {
      throw new ServiceUnavailableException(
        `Catalog is unavailable (${CATALOG_KEY}). The API seeds it on boot when LocalStack is reachable. ${(error as Error).message}`,
      );
    }
  }

  async listClients(): Promise<Client[]> {
    const catalog = await this.getCatalog();
    return catalog.clients.length ? catalog.clients : allClients();
  }

  async getClient(clientId: string): Promise<Client> {
    const catalog = await this.getCatalog();
    const client = catalog.clients.find((entry) => entry.id === clientId);
    if (!client) {
      throw new BadRequestException(`Unknown client "${clientId}"`);
    }
    return client;
  }

  async listOrders(clientId: string): Promise<Order[]> {
    await this.getClient(clientId);
    const catalog = await this.getCatalog();
    return catalog.orders
      .filter((order) => order.clientId === clientId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async getSupplierNames(): Promise<string[]> {
    const catalog = await this.getCatalog();
    const fromOrders = new Set<string>();
    for (const order of catalog.orders) {
      for (const item of order.items) {
        fromOrders.add(item.supplier);
      }
    }
    return fromOrders.size ? [...fromOrders].sort() : supplierNames();
  }

  async getOrdersByIds(clientId: string, orderIds: string[]): Promise<Order[]> {
    const catalog = await this.getCatalog();
    const unique = [...new Set(orderIds)];
    const byId = new Map(catalog.orders.map((order) => [order.id, order]));
    const missing: string[] = [];
    const wrongClient: string[] = [];
    const orders: Order[] = [];
    for (const id of unique) {
      const order = byId.get(id);
      if (!order) {
        missing.push(id);
      } else if (order.clientId !== clientId) {
        wrongClient.push(id);
      } else {
        orders.push(structuredClone(order));
      }
    }
    if (missing.length) {
      throw new BadRequestException(`Unknown orders: ${missing.slice(0, 8).join(", ")}`);
    }
    if (wrongClient.length) {
      throw new BadRequestException(`Orders do not belong to ${clientId}: ${wrongClient.slice(0, 8).join(", ")}`);
    }
    return orders;
  }

  async mutateOrder(
    orderId: string,
    patch: { status?: OrderStatus; bumpRev?: boolean; qtyDelta?: number },
  ): Promise<Order> {
    const run = this.writeChain.then(async () => {
      if (patch.status && !STATUSES.includes(patch.status)) {
        throw new BadRequestException(`status must be one of ${STATUSES.join(", ")}`);
      }
      const catalog = structuredClone(await this.getCatalog(true));
      const order = catalog.orders.find((entry) => entry.id === orderId);
      if (!order) {
        throw new NotFoundException(`Order ${orderId} not found`);
      }
      if (patch.bumpRev !== false) {
        order.rev += 1;
      }
      if (patch.status) {
        order.status = patch.status;
      } else {
        const current = STATUSES.indexOf(order.status);
        order.status = STATUSES[(current + 1) % STATUSES.length];
      }
      const qtyDelta = patch.qtyDelta ?? 1;
      if (qtyDelta !== 0 && order.items.length > 0) {
        const item: OrderItem = order.items[0];
        item.qty = Math.max(1, item.qty + qtyDelta);
      }
      catalog.version += 1;
      catalog.updatedAt = new Date().toISOString();
      await this.putCatalog(catalog);
      this.cached = { at: Date.now(), catalog };
      return structuredClone(order);
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  filterHash(orders: Order[]): string {
    return filterHashForOrders(orders);
  }

  documentCount(order: Order): number {
    return documentCount(order);
  }

  private async putCatalog(catalog: Catalog): Promise<void> {
    await this.aws.s3.send(
      new PutObjectCommand({
        Bucket: env.bucket,
        Key: CATALOG_KEY,
        Body: JSON.stringify(catalog, null, 2),
        ContentType: "application/json",
      }),
    );
  }

  private async objectExists(key: string): Promise<boolean> {
    try {
      await this.aws.s3.send(new HeadObjectCommand({ Bucket: env.bucket, Key: key }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (error as { name?: string }).name;
      if (status === 404 || name === "NotFound" || name === "NoSuchKey") {
        return false;
      }
      throw error;
    }
  }
}
