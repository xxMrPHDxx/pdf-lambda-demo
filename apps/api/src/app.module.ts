import { Module } from "@nestjs/common";
import { AwsModule } from "./aws/aws.service";
import { BootstrapController } from "./bootstrap.controller";
import { CatalogService } from "./catalog/catalog.service";
import { EventsController } from "./events.controller";
import { HealthController } from "./health.controller";
import { InfraService } from "./infra/infra.service";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs/jobs.service";
import { SchedulerService } from "./jobs/scheduler.service";
import { OrdersController } from "./orders.controller";
import { RedisService } from "./redis/redis.service";

@Module({
  imports: [AwsModule],
  controllers: [
    BootstrapController,
    OrdersController,
    JobsController,
    EventsController,
    HealthController,
  ],
  providers: [InfraService, CatalogService, RedisService, JobsService, SchedulerService],
})
export class AppModule {}
