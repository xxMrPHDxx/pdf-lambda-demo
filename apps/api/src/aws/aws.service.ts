import { Global, Injectable, Module, OnModuleDestroy } from "@nestjs/common";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, type S3ClientConfig } from "@aws-sdk/client-s3";
import { SESClient } from "@aws-sdk/client-ses";
import { SQSClient } from "@aws-sdk/client-sqs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config";

function localCredentials(): { accessKeyId: string; secretAccessKey: string } | undefined {
  if (process.env.AWS_ACCESS_KEY_ID) {
    return undefined;
  }
  const endpoint = env.endpoint.toLowerCase();
  if (endpoint.includes("localhost") || endpoint.includes("localstack") || endpoint.includes("127.0.0.1")) {
    return { accessKeyId: "test", secretAccessKey: "test" };
  }
  return undefined;
}

@Injectable()
export class AwsService implements OnModuleDestroy {
  readonly ddb: DynamoDBClient;
  readonly ddbDoc: DynamoDBDocumentClient;
  readonly s3: S3Client;
  readonly s3Public: S3Client;
  readonly sqs: SQSClient;
  readonly ses: SESClient;

  constructor() {
    const credentials = localCredentials();
    const base = {
      region: env.region,
      ...(env.endpoint ? { endpoint: env.endpoint } : {}),
      ...(credentials ? { credentials } : {}),
    };

    this.ddb = new DynamoDBClient(base);
    this.ddbDoc = DynamoDBDocumentClient.from(this.ddb, {
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
    });

    const s3Config: S3ClientConfig = {
      region: env.region,
      ...(env.endpoint ? { endpoint: env.endpoint, forcePathStyle: true } : {}),
      ...(credentials ? { credentials } : {}),
    };
    this.s3 = new S3Client(s3Config);

    const publicEndpoint = env.publicEndpoint || env.endpoint;
    this.s3Public = new S3Client({
      region: env.region,
      ...(publicEndpoint ? { endpoint: publicEndpoint, forcePathStyle: true } : {}),
      ...(credentials ? { credentials } : {}),
    });

    this.sqs = new SQSClient(base);
    this.ses = new SESClient(base);
  }

  async presignGet(key: string): Promise<string> {
    return getSignedUrl(
      this.s3Public,
      new GetObjectCommand({ Bucket: env.bucket, Key: key }),
      { expiresIn: env.presignExpiresSeconds },
    );
  }

  onModuleDestroy(): void {
    this.ddb.destroy();
    this.s3.destroy();
    this.s3Public.destroy();
    this.sqs.destroy();
    this.ses.destroy();
  }
}

@Global()
@Module({
  providers: [AwsService],
  exports: [AwsService],
})
export class AwsModule {}
