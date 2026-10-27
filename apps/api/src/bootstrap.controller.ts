import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { CatalogService } from "./catalog/catalog.service";
import { JobsService } from "./jobs/jobs.service";
import type { BootstrapResponse } from "./types";

@Controller()
export class BootstrapController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly jobs: JobsService,
  ) {}

  @Get("bootstrap")
  async bootstrap(@Query("clientId") clientId?: string): Promise<BootstrapResponse> {
    const clients = await this.catalog.listClients();
    const selected = clientId || clients[0]?.id;
    if (!selected) {
      throw new BadRequestException("No clients configured");
    }
    const [orders, suppliers, catalog, snapshot] = await Promise.all([
      this.catalog.listOrders(selected),
      this.catalog.getSupplierNames(),
      this.catalog.getCatalog(),
      this.jobs.snapshot(selected),
    ]);
    return {
      ...snapshot,
      clients,
      suppliers,
      orders,
      catalogVersion: catalog.version,
      catalogUpdatedAt: catalog.updatedAt,
    };
  }
}
