import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  BatchGetCommand,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type BatchWriteCommandInput,
  type BatchWriteCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { AwsService } from "../aws/aws.service";
import { CatalogService } from "../catalog/catalog.service";
import { env, TERMINAL_JOB_STATUSES } from "../config";
import { RedisService } from "../redis/redis.service";
import type {
  BatchDto,
  BatchRecord,
  JobDto,
  JobRecord,
  Limits,
  LimitsSnapshot,
  Order,
  StoredEmail,
} from "../types";

const JOB_SK = "META";
const jobPk = (jobId: string) => `JOB#${jobId}`;
const batchSk = (index: number) => `BATCH#${String(index).padStart(4, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CreateJobInput {
  clientId: string;
  orderIds: string[];
  email?: string;
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private queuedCache?: { at: number; jobs: JobRecord[] };

  constructor(
    private readonly aws: AwsService,
    private readonly catalog: CatalogService,
    private readonly redis: RedisService,
  ) {}

  async createJob(input: CreateJobInput): Promise<JobDto> {
    if (!input.clientId) {
      throw new BadRequestException("clientId is required");
    }
    if (!Array.isArray(input.orderIds) || input.orderIds.length === 0) {
      throw new BadRequestException("Select at least one order");
    }
    if (input.orderIds.length > 200) {
      throw new BadRequestException("A job can contain at most 200 orders");
    }
    const client = await this.catalog.getClient(input.clientId);
    const orders = await this.catalog.getOrdersByIds(input.clientId, input.orderIds);
    orders.sort((a, b) => a.id.localeCompare(b.id));

    const email = (input.email ?? client.email).trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException("A valid notification email is required");
    }

    const now = new Date().toISOString();
    const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const filterHash = this.catalog.filterHash(orders);
    const totalDocs = orders.reduce((sum, order) => sum + this.catalog.documentCount(order), 0);
    const batches = chunk(orders, env.batchSize);

    const job: JobRecord = {
      pk: jobPk(jobId),
      sk: JOB_SK,
      gsi1pk: `CLIENT#${client.id}`,
      gsi1sk: `${now}#${jobId}`,
      gsi2pk: "STATUS#QUEUED",
      gsi2sk: `${now}#${jobId}`,
      jobId,
      clientId: client.id,
      clientName: client.name,
      email,
      status: "QUEUED",
      createdAt: now,
      orderIds: orders.map((order) => order.id),
      batchSize: env.batchSize,
      batchCount: batches.length,
      batchesDone: 0,
      pdfsTotal: totalDocs,
      pdfsDone: 0,
      pdfsCached: 0,
      pdfsGenerated: 0,
      filterHash,
    };

    try {
      // Batches are written first so a QUEUED job is never visible to the
      // scheduler before all of its batch rows exist.
      await this.writeBatches(job, batches);
      await this.aws.ddbDoc.send(
        new PutCommand({
          TableName: env.table,
          Item: job,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (error) {
      this.logger.error(`Could not create job ${jobId}: ${(error as Error).message}`);
      throw new InternalServerErrorException(`Could not create job: ${(error as Error).message}`);
    }

    this.queuedCache = undefined;
    this.logger.log(
      `Queued ${jobId} for ${client.id}: ${orders.length} orders, ${batches.length} batches, ${totalDocs} PDFs`,
    );
    return this.toJobDto(job);
  }

  private async writeBatches(job: JobRecord, batches: Order[][]): Promise<void> {
    const records: BatchRecord[] = batches.map((orders, index) => ({
      pk: job.pk,
      sk: batchSk(index),
      jobId: job.jobId,
      batchIndex: index,
      status: "PENDING",
      orderIds: orders.map((order) => order.id),
      orders,
      pdfsTotal: orders.reduce((sum, order) => sum + this.catalog.documentCount(order), 0),
      pdfsDone: 0,
      pdfsCached: 0,
      pdfsGenerated: 0,
      docs: [],
    }));

    for (const group of chunk(records, 25)) {
      let pending: BatchWriteCommandInput["RequestItems"] | undefined = {
        [env.table]: group.map((record) => ({ PutRequest: { Item: record } })),
      };
      for (let attempt = 0; attempt < 4 && pending; attempt++) {
        const result: BatchWriteCommandOutput = await this.aws.ddbDoc.send(
          new BatchWriteCommand({ RequestItems: pending }),
        );
        pending = result.UnprocessedItems;
        if (pending && Object.keys(pending).length > 0) {
          await sleep(100 * (attempt + 1));
        } else {
          pending = undefined;
        }
      }
      if (pending && Object.keys(pending).length > 0) {
        throw new Error("DynamoDB did not accept all batch records");
      }
    }
  }

  async getJob(jobId: string): Promise<JobDto> {
    const record = await this.getJobRecord(jobId);
    const positions = await this.getQueuePositions();
    return this.toJobDto(record, positions.get(record.jobId));
  }

  async getJobDetail(jobId: string): Promise<{ job: JobDto; batches: BatchDto[] }> {
    const record = await this.getJobRecord(jobId);
    const batches = await this.listBatchRecords(jobId);
    const positions = await this.getQueuePositions();
    return {
      job: this.toJobDto(record, positions.get(record.jobId)),
      batches: batches.map((batch) => this.toBatchDto(batch)),
    };
  }

  async getJobRecord(jobId: string): Promise<JobRecord> {
    const result = await this.aws.ddbDoc.send(
      new GetCommand({
        TableName: env.table,
        Key: { pk: jobPk(jobId), sk: JOB_SK },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    return result.Item as JobRecord;
  }

  async listBatchRecords(jobId: string): Promise<BatchRecord[]> {
    const result = await this.aws.ddbDoc.send(
      new QueryCommand({
        TableName: env.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": jobPk(jobId), ":prefix": "BATCH#" },
        ConsistentRead: true,
      }),
    );
    return ((result.Items ?? []) as BatchRecord[]).sort((a, b) => a.batchIndex - b.batchIndex);
  }

  async listJobs(clientId: string, limit = 20): Promise<JobDto[]> {
    const result = await this.aws.ddbDoc.send(
      new QueryCommand({
        TableName: env.table,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `CLIENT#${clientId}` },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    const positions = await this.getQueuePositions();
    return ((result.Items ?? []) as JobRecord[]).map((record) =>
      this.toJobDto(record, positions.get(record.jobId)),
    );
  }

  async listQueued(limit = 50): Promise<JobRecord[]> {
    const result = await this.aws.ddbDoc.send(
      new QueryCommand({
        TableName: env.table,
        IndexName: "gsi2",
        KeyConditionExpression: "gsi2pk = :pk",
        ExpressionAttributeValues: { ":pk": "STATUS#QUEUED" },
        ScanIndexForward: true,
        Limit: limit,
      }),
    );
    return (result.Items ?? []) as JobRecord[];
  }

  private async getQueuedCached(): Promise<JobRecord[]> {
    if (this.queuedCache && Date.now() - this.queuedCache.at < 700) {
      return this.queuedCache.jobs;
    }
    const jobs = await this.listQueued(100);
    this.queuedCache = { at: Date.now(), jobs };
    return jobs;
  }

  private async getQueuePositions(): Promise<Map<string, number>> {
    const queued = await this.getQueuedCached();
    return new Map(queued.map((job, index) => [job.jobId, index + 1]));
  }

  async statuses(jobIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const group of chunk([...new Set(jobIds)], 90)) {
      let keys: Record<string, unknown>[] = group.map((jobId) => ({
        pk: jobPk(jobId),
        sk: JOB_SK,
      }));
      for (let attempt = 0; attempt < 3 && keys.length > 0; attempt++) {
        const result = await this.aws.ddbDoc.send(
          new BatchGetCommand({
            RequestItems: {
              [env.table]: {
                Keys: keys,
                ProjectionExpression: "pk, #st",
                ExpressionAttributeNames: { "#st": "status" },
                ConsistentRead: true,
              },
            },
          }),
        );
        for (const item of result.Responses?.[env.table] ?? []) {
          const pk = String(item.pk ?? "");
          out.set(pk.replace(/^JOB#/, ""), String(item.status ?? ""));
        }
        keys = (result.UnprocessedKeys?.[env.table]?.Keys ?? []) as Record<string, unknown>[];
        if (keys.length > 0) {
          await sleep(120);
        }
      }
    }
    return out;
  }

  async markRunning(jobId: string): Promise<BatchRecord[] | null> {
    const now = new Date().toISOString();
    try {
      await this.aws.ddbDoc.send(
        new UpdateCommand({
          TableName: env.table,
          Key: { pk: jobPk(jobId), sk: JOB_SK },
          UpdateExpression:
            "SET #st = :running, gsi2pk = :gsi, startedAt = :now, updatedAt = :now",
          ConditionExpression: "#st = :queued",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: {
            ":running": "RUNNING",
            ":queued": "QUEUED",
            ":gsi": "STATUS#RUNNING",
            ":now": now,
          },
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
        return null;
      }
      throw error;
    }
    this.queuedCache = undefined;
    return this.listBatchRecords(jobId);
  }

  async enqueueBatches(job: JobRecord, batches: BatchRecord[]): Promise<void> {
    for (const group of chunk(batches, 10)) {
      const result = await this.aws.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: env.batchQueueUrl,
          Entries: group.map((batch) => ({
            Id: `b${batch.batchIndex}`,
            MessageBody: JSON.stringify({
              type: "pdf.batch",
              jobId: job.jobId,
              clientId: job.clientId,
              batchIndex: batch.batchIndex,
              orderIds: batch.orderIds,
            }),
          })),
        }),
      );
      if (result.Failed && result.Failed.length > 0) {
        throw new Error(
          `SQS rejected ${result.Failed.length} batch message(s): ${result.Failed.map((entry) => entry.Message).join("; ")}`,
        );
      }
    }
  }

  async markFailed(jobId: string, message: string): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.aws.ddbDoc.send(
        new UpdateCommand({
          TableName: env.table,
          Key: { pk: jobPk(jobId), sk: JOB_SK },
          UpdateExpression:
            "SET #st = :failed, gsi2pk = :gsi, #err = :err, finishedAt = :now, updatedAt = :now",
          ConditionExpression: "#st <> :completed AND #st <> :failed",
          ExpressionAttributeNames: { "#st": "status", "#err": "error" },
          ExpressionAttributeValues: {
            ":failed": "FAILED",
            ":completed": "COMPLETED",
            ":gsi": "STATUS#FAILED",
            ":err": message.slice(0, 900),
            ":now": now,
          },
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") {
        throw error;
      }
    }
    this.queuedCache = undefined;
  }

  async retryJob(jobId: string): Promise<JobDto> {
    const job = await this.getJobRecord(jobId);
    if (job.status !== "FAILED") {
      throw new BadRequestException("Only failed jobs can be retried");
    }
    return this.createJob({ clientId: job.clientId, orderIds: job.orderIds, email: job.email });
  }

  async limits(clientId: string): Promise<Limits> {
    const [counts, queued] = await Promise.all([this.redis.counts(clientId), this.getQueuedCached()]);
    return {
      globalRunning: counts.global,
      globalLimit: env.maxRunningJobs,
      clientRunning: counts.client,
      clientLimit: env.maxClientRunningJobs,
      queuedJobs: queued.length,
    };
  }

  async snapshot(clientId: string): Promise<LimitsSnapshot> {
    const [jobs, limits] = await Promise.all([this.listJobs(clientId), this.limits(clientId)]);
    return { jobs, limits, serverTime: new Date().toISOString() };
  }

  async downloadUrl(jobId: string): Promise<string> {
    const job = await this.getJobRecord(jobId);
    if (job.status !== "COMPLETED" || !job.zipKey) {
      throw new BadRequestException("ZIP is not ready yet");
    }
    return this.aws.presignGet(job.zipKey);
  }

  async getStoredEmail(jobId: string): Promise<StoredEmail> {
    await this.getJobRecord(jobId);
    const key = `emails/${jobId}.json`;
    try {
      const result = await this.aws.s3.send(
        new GetObjectCommand({ Bucket: env.bucket, Key: key }),
      );
      const body = await result.Body?.transformToString("utf-8");
      if (!body) {
        throw new NotFoundException("Email record is empty");
      }
      return JSON.parse(body) as StoredEmail;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === "NoSuchKey") {
        throw new NotFoundException("No email has been recorded for this job yet");
      }
      throw error;
    }
  }

  toJobDto(record: JobRecord, queuePosition?: number): JobDto {
    const pdfsTotal = record.pdfsTotal ?? 0;
    const pdfsDone = record.pdfsDone ?? 0;
    let percent = pdfsTotal > 0 ? Math.min(100, Math.round((pdfsDone / pdfsTotal) * 100)) : 0;
    if (record.status === "COMPLETED") {
      percent = 100;
    }
    return {
      jobId: record.jobId,
      clientId: record.clientId,
      clientName: record.clientName,
      email: record.email,
      status: record.status,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      error: record.error,
      orderCount: record.orderIds?.length ?? 0,
      batchCount: record.batchCount ?? 0,
      batchesDone: record.batchesDone ?? 0,
      pdfsTotal,
      pdfsDone,
      pdfsCached: record.pdfsCached ?? 0,
      pdfsGenerated: record.pdfsGenerated ?? 0,
      percent,
      zipBytes: record.zipBytes,
      zipCached: record.zipCached ?? false,
      emailMessageId: record.emailMessageId,
      emailError: record.emailError,
      supplierCounts: record.supplierCounts ?? {},
      queuePosition,
      canDownload: record.status === "COMPLETED" && Boolean(record.zipKey),
    };
  }

  toBatchDto(batch: BatchRecord): BatchDto {
    return {
      index: batch.batchIndex,
      status: batch.status,
      orderIds: batch.orderIds ?? [],
      orderCount: batch.orderIds?.length ?? 0,
      pdfsTotal: batch.pdfsTotal ?? 0,
      pdfsDone: batch.pdfsDone ?? 0,
      pdfsCached: batch.pdfsCached ?? 0,
      pdfsGenerated: batch.pdfsGenerated ?? 0,
      startedAt: batch.startedAt,
      finishedAt: batch.finishedAt,
      error: batch.error,
      documents: batch.docs?.length ?? 0,
    };
  }

  isTerminal(status: string | undefined): boolean {
    return !status || TERMINAL_JOB_STATUSES.has(status);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
