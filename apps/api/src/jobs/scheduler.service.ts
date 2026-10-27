import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { InfraService } from "../infra/infra.service";
import { RedisService } from "../redis/redis.service";
import { JobsService } from "./jobs.service";
import { env } from "../config";

/**
 * Admission control: promotes QUEUED jobs oldest-first while respecting
 * 10 global / 2 per-client running slots. Slots live in Redis; job state
 * remains authoritative in DynamoDB, so a crashed API cannot leak capacity.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly infra: InfraService,
    private readonly jobs: JobsService,
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref?.();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.infra.ready) {
      return;
    }
    this.ticking = true;
    try {
      await this.reconcile();
      await this.admit();
    } catch (error) {
      this.logger.error(`Scheduler tick failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async reconcile(): Promise<void> {
    const owners = await this.redis.owners();
    const ids = Object.keys(owners);
    if (ids.length === 0) {
      return;
    }
    const statuses = await this.jobs.statuses(ids);
    for (const jobId of ids) {
      const status = statuses.get(jobId);
      if (this.jobs.isTerminal(status)) {
        await this.redis.release(jobId, owners[jobId]);
        this.logger.log(`Released slot for ${jobId} (${status ?? "missing"})`);
      }
    }
  }

  private async admit(): Promise<void> {
    const queued = await this.jobs.listQueued(50);
    if (queued.length === 0) {
      return;
    }
    for (const job of queued) {
      const result = await this.redis.tryAcquire(
        job.jobId,
        job.clientId,
        env.maxRunningJobs,
        env.maxClientRunningJobs,
      );
      if (result === "global-full") {
        return;
      }
      if (result === "unavailable") {
        return;
      }
      if (result !== "acquired") {
        continue;
      }
      try {
        let batches = await this.jobs.markRunning(job.jobId);
        if (!batches) {
          await this.redis.release(job.jobId, job.clientId);
          continue;
        }
        if (batches.length !== job.batchCount) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          batches = await this.jobs.listBatchRecords(job.jobId);
          if (batches.length !== job.batchCount) {
            throw new Error(
              `expected ${job.batchCount} batches, found ${batches.length}`,
            );
          }
        }
        await this.jobs.enqueueBatches(job, batches);
        this.logger.log(
          `Admitted ${job.jobId} (${job.clientId}) with ${batches.length} batch(es)`,
        );
      } catch (error) {
        const message = (error as Error).message;
        this.logger.error(`Failed to start ${job.jobId}: ${message}`);
        await this.jobs.markFailed(job.jobId, message).catch(() => undefined);
        await this.redis.release(job.jobId, job.clientId);
      }
    }
  }
}
