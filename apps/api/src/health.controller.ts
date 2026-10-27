import {
  Controller,
  Get,
  ServiceUnavailableException,
} from "@nestjs/common";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { AwsService } from "./aws/aws.service";
import { env } from "./config";
import { InfraService } from "./infra/infra.service";
import { RedisService } from "./redis/redis.service";

@Controller()
export class HealthController {
  private cached?: { at: number; body: Record<string, unknown> };

  constructor(
    private readonly infra: InfraService,
    private readonly aws: AwsService,
    private readonly redis: RedisService,
  ) {}

  @Get("health")
  async health(): Promise<Record<string, unknown>> {
    if (!this.infra.ready) {
      throw new ServiceUnavailableException({
        status: "starting",
        message: "Provisioning LocalStack resources / seeding catalog",
      });
    }
    if (this.cached && Date.now() - this.cached.at < 3000) {
      return this.cached.body;
    }

    const checks: Record<string, string> = {};
    const [s3, ddb, sqs, redis] = await Promise.allSettled([
      this.aws.s3.send(new HeadBucketCommand({ Bucket: env.bucket })),
      this.aws.ddb.send(new DescribeTableCommand({ TableName: env.table })),
      this.aws.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: env.batchQueueUrl,
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        }),
      ),
      this.redis.ping(),
    ]);
    checks.s3 = s3.status === "fulfilled" ? "ok" : "error";
    checks.dynamodb = ddb.status === "fulfilled" ? "ok" : "error";
    checks.sqs = sqs.status === "fulfilled" ? "ok" : "error";
    checks.redis = redis.status === "fulfilled" && redis.value ? "ok" : "degraded";

    const body = {
      status: checks.redis === "ok" ? "ok" : "degraded",
      checks,
      resources: {
        bucket: env.bucket,
        table: env.table,
        batchQueue: env.batchQueueUrl,
        finalizeQueue: env.finalizeQueueUrl,
      },
      limits: {
        global: env.maxRunningJobs,
        perClient: env.maxClientRunningJobs,
        batchSize: env.batchSize,
      },
      provisioned: env.autoProvision,
      serverTime: new Date().toISOString(),
    };
    this.cached = { at: Date.now(), body };
    return body;
  }
}
