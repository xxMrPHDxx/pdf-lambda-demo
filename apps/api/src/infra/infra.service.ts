import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
} from "@aws-sdk/client-sqs";
import { VerifyEmailIdentityCommand } from "@aws-sdk/client-ses";
import { AwsService } from "../aws/aws.service";
import { CatalogService } from "../catalog/catalog.service";
import { env, QUEUE_NAMES } from "../config";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class InfraService implements OnApplicationBootstrap {
  private readonly logger = new Logger(InfraService.name);
  ready = false;
  private pending?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;

  constructor(
    private readonly aws: AwsService,
    private readonly catalog: CatalogService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureReady();
    } catch (error) {
      this.logger.error(`Provisioning failed, retrying in the background: ${(error as Error).message}`);
      this.scheduleRetry();
    }
  }

  ensureReady(): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    if (!this.pending) {
      this.pending = this.ensure()
        .then(() => {
          this.ready = true;
          this.logger.log(
            `Infrastructure ready (bucket=${env.bucket}, table=${env.table}, provisioned=${env.autoProvision})`,
          );
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    return this.pending;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.ensureReady().catch((error) => {
        this.logger.error(`Provisioning retry failed: ${(error as Error).message}`);
        this.scheduleRetry();
      });
    }, 3000);
    this.retryTimer.unref?.();
  }

  private async ensure(): Promise<void> {
    await this.ensureBucket();
    await this.ensureLifecycle();
    await this.ensureTable();
    await this.ensureQueues();
    await this.ensureSesIdentity();
    await this.ensureCatalog();
  }

  private async ensureBucket(): Promise<void> {
    if (!env.autoProvision) {
      try {
        await this.aws.s3.send(new HeadBucketCommand({ Bucket: env.bucket }));
      } catch {
        throw new Error(`Bucket ${env.bucket} does not exist and AUTO_PROVISION=false`);
      }
      return;
    }
    await this.retry("create bucket", async () => {
      try {
        await this.aws.s3.send(
          new CreateBucketCommand({
            Bucket: env.bucket,
            ...(env.region === "us-east-1"
              ? {}
              : { CreateBucketConfiguration: { LocationConstraint: env.region as never } }),
          }),
        );
        this.logger.log(`Created bucket ${env.bucket}`);
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
          return;
        }
        throw error;
      }
    });
  }

  private async ensureLifecycle(): Promise<void> {
    if (!env.autoProvision) {
      return;
    }
    const rules: LifecycleRule[] = [
      {
        ID: "expire-pdf-cache",
        Filter: { Prefix: "pdfs/" },
        Status: "Enabled",
        Expiration: { Days: env.pdfCacheDays },
      },
      {
        ID: "expire-zip-cache",
        Filter: { Prefix: "zips/" },
        Status: "Enabled",
        Expiration: { Days: Math.max(1, Math.ceil(env.zipCacheHours / 24)) },
      },
      {
        ID: "expire-email-copies",
        Filter: { Prefix: "emails/" },
        Status: "Enabled",
        Expiration: { Days: 30 },
      },
    ];
    try {
      await this.aws.s3.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: env.bucket,
          LifecycleConfiguration: { Rules: rules },
        }),
      );
      this.logger.log(
        `Lifecycle set: PDFs ${env.pdfCacheDays}d, ZIPs 1d, email copies 30d`,
      );
    } catch (error) {
      this.logger.warn(`Could not set lifecycle configuration: ${(error as Error).message}`);
    }
  }

  private async ensureTable(): Promise<void> {
    const exists = await this.tableExists();
    if (!exists) {
      if (!env.autoProvision) {
        throw new Error(`DynamoDB table ${env.table} does not exist and AUTO_PROVISION=false`);
      }
      await this.retry("create table", async () => {
        try {
          await this.aws.ddb.send(
            new CreateTableCommand({
              TableName: env.table,
              BillingMode: "PAY_PER_REQUEST",
              AttributeDefinitions: [
                { AttributeName: "pk", AttributeType: "S" },
                { AttributeName: "sk", AttributeType: "S" },
                { AttributeName: "gsi1pk", AttributeType: "S" },
                { AttributeName: "gsi1sk", AttributeType: "S" },
                { AttributeName: "gsi2pk", AttributeType: "S" },
                { AttributeName: "gsi2sk", AttributeType: "S" },
              ],
              KeySchema: [
                { AttributeName: "pk", KeyType: "HASH" },
                { AttributeName: "sk", KeyType: "RANGE" },
              ],
              GlobalSecondaryIndexes: [
                {
                  IndexName: "gsi1",
                  KeySchema: [
                    { AttributeName: "gsi1pk", KeyType: "HASH" },
                    { AttributeName: "gsi1sk", KeyType: "RANGE" },
                  ],
                  Projection: { ProjectionType: "ALL" },
                },
                {
                  IndexName: "gsi2",
                  KeySchema: [
                    { AttributeName: "gsi2pk", KeyType: "HASH" },
                    { AttributeName: "gsi2sk", KeyType: "RANGE" },
                  ],
                  Projection: { ProjectionType: "ALL" },
                },
              ],
            }),
          );
          this.logger.log(`Created DynamoDB table ${env.table}`);
        } catch (error) {
          if ((error as { name?: string }).name === "ResourceInUseException") {
            return;
          }
          throw error;
        }
      });
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      const status = await this.describeTableStatus();
      if (status === "ACTIVE") {
        return;
      }
      await sleep(500);
    }
    throw new Error(`DynamoDB table ${env.table} did not become ACTIVE`);
  }

  private async tableExists(): Promise<boolean> {
    try {
      await this.aws.ddb.send(new DescribeTableCommand({ TableName: env.table }));
      return true;
    } catch (error) {
      if (error instanceof ResourceNotFoundException || (error as { name?: string }).name === "ResourceNotFoundException") {
        return false;
      }
      throw error;
    }
  }

  private async describeTableStatus(): Promise<string | undefined> {
    const out = await this.aws.ddb.send(new DescribeTableCommand({ TableName: env.table }));
    return out.Table?.TableStatus;
  }

  private async ensureQueues(): Promise<void> {
    if (!env.autoProvision) {
      for (const name of [QUEUE_NAMES.batches, QUEUE_NAMES.finalize]) {
        try {
          await this.aws.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
        } catch {
          throw new Error(`SQS queue ${name} does not exist and AUTO_PROVISION=false`);
        }
      }
      return;
    }

    const batchesDlq = await this.createQueue(QUEUE_NAMES.batchesDlq);
    const finalizeDlq = await this.createQueue(QUEUE_NAMES.finalizeDlq);
    const batchesDlqArn = await this.queueArn(batchesDlq);
    const finalizeDlqArn = await this.queueArn(finalizeDlq);

    await this.createQueue(QUEUE_NAMES.batches, {
      VisibilityTimeout: "180",
      ReceiveMessageWaitTimeSeconds: "20",
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: batchesDlqArn, maxReceiveCount: "3" }),
    });
    await this.createQueue(QUEUE_NAMES.finalize, {
      VisibilityTimeout: "300",
      ReceiveMessageWaitTimeSeconds: "20",
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: finalizeDlqArn, maxReceiveCount: "3" }),
    });
  }

  private async createQueue(name: string, attributes: Record<string, string> = {}): Promise<string> {
    return this.retry(`create queue ${name}`, async () => {
      const out = await this.aws.sqs.send(
        new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
      );
      if (!out.QueueUrl) {
        throw new Error(`no queue URL returned for ${name}`);
      }
      return out.QueueUrl;
    });
  }

  private async queueArn(queueUrl: string): Promise<string> {
    const out = await this.aws.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }),
    );
    const arn = out.Attributes?.QueueArn;
    if (!arn) {
      throw new Error(`could not resolve ARN for ${queueUrl}`);
    }
    return arn;
  }

  private async ensureSesIdentity(): Promise<void> {
    if (!env.autoProvision) {
      return;
    }
    try {
      await this.aws.ses.send(new VerifyEmailIdentityCommand({ EmailAddress: env.sesFrom }));
      this.logger.log(`SES identity present: ${env.sesFrom}`);
    } catch (error) {
      // LocalStack accepts any sender; real AWS sends a verification email.
      this.logger.warn(`SES identity setup skipped: ${(error as Error).message}`);
    }
  }

  private async ensureCatalog(): Promise<void> {
    await this.retry("seed catalog", () => this.catalog.ensureSeeded());
  }

  private async retry<T>(label: string, fn: () => Promise<T>, attempts = 20): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === attempts) {
          break;
        }
        if (attempt === 1) {
          this.logger.log(`Waiting for LocalStack/AWS (${label})...`);
        }
        await sleep(Math.min(2000, 250 * attempt));
      }
    }
    throw new Error(`${label} failed after ${attempts} attempts: ${(lastError as Error)?.message ?? lastError}`);
  }
}
