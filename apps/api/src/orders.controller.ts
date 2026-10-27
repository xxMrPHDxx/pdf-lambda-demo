import { BadRequestException, Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CatalogService } from "./catalog/catalog.service";
import { MutateOrderDto } from "./jobs/dto";

@Controller("orders")
export class OrdersController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  async list(@Query("clientId") clientId?: string) {
    if (!clientId) {
      throw new BadRequestException("clientId is required");
    }
    return {
      orders: await this.catalog.listOrders(clientId),
      suppliers: await this.catalog.getSupplierNames(),
    };
  }

  @Post(":orderId/mutate")
  async mutate(@Param("orderId") orderId: string, @Body() dto: MutateOrderDto) {
    const order = await this.catalog.mutateOrder(orderId, dto);
    return {
      order,
      message: `Revision bumped to ${order.rev} (${order.status}); cached PDFs and ZIP for the previous revision will not be reused.`,
    };
  }
}
