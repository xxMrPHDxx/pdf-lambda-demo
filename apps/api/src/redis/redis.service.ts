import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { env } from "../config";

const GLOBAL_KEY = "pdfdemo:limit:global";
const OWNERS_KEY = "pdfdemo:limit:owners";
const clientKey = (clientId: string) => `pdfdemo:limit:client:${clientId}`;

const ACQUIRE_LUA = `
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then return 2 end
local globalCount = redis.call('SCARD', KEYS[1])
if globalCount >= tonumber(ARGV[2]) then return -1 end
local clientCount = redis.call('SCARD', KEYS[2])
if clientCount >= tonumber(ARGV[3]) then return -2 end
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
return 1
`;

const RELEASE_LUA = `
redis.call('SREM', KEYS[1], ARGV[1])
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
return 1
`;

export type AcquireResult = "acquired" | "global-full" | "client-full" | "held" | "unavailable";

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly redis: Redis;
  private connecting?: Promise<void>;
  private lastErrorAt = 0;

  constructor() {
    this.redis = new Redis(env.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 3000,
      retryStrategy: (times) => Math.min(times * 500, 3000),
    });
    this.redis.on("error", (error) => {
      if (Date.now() - this.lastErrorAt > 5000) {
        this.lastErrorAt = Date.now();
        this.logger.warn(`Redis error: ${error.message}`);
      }
    });
  }

  private async ensure(): Promise<void> {
    if (this.redis.status === "ready") {
      return;
    }
    if (!this.connecting) {
      this.connecting = (async () => {
        if (this.redis.status === "wait" || this.redis.status === "end") {
          await this.redis.connect();
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("timed out waiting for Redis"));
          }, 5000);
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };
          const cleanup = () => {
            clearTimeout(timer);
            this.redis.removeListener("ready", onReady);
            this.redis.removeListener("error", onError);
          };
          this.redis.once("ready", onReady);
          this.redis.once("error", onError);
        });
      })().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  async tryAcquire(
    jobId: string,
    clientId: string,
    maxGlobal: number,
    maxClient: number,
  ): Promise<AcquireResult> {
    try {
      await this.ensure();
      const result = (await this.redis.eval(
        ACQUIRE_LUA,
        3,
        GLOBAL_KEY,
        clientKey(clientId),
        OWNERS_KEY,
        jobId,
        String(maxGlobal),
        String(maxClient),
        clientId,
      )) as number;
      if (result === 1) return "acquired";
      if (result === 2) return "held";
      if (result === -1) return "global-full";
      if (result === -2) return "client-full";
      return "unavailable";
    } catch (error) {
      this.log(error);
      return "unavailable";
    }
  }

  async release(jobId: string, clientId: string): Promise<void> {
    try {
      await this.ensure();
      await this.redis.eval(RELEASE_LUA, 3, GLOBAL_KEY, clientKey(clientId), OWNERS_KEY, jobId);
    } catch (error) {
      this.log(error);
    }
  }

  async owners(): Promise<Record<string, string>> {
    try {
      await this.ensure();
      return await this.redis.hgetall(OWNERS_KEY);
    } catch (error) {
      this.log(error);
      return {};
    }
  }

  async counts(clientId: string): Promise<{ global: number; client: number; available: boolean }> {
    try {
      await this.ensure();
      const [global, client] = (await this.redis
        .pipeline()
        .scard(GLOBAL_KEY)
        .scard(clientKey(clientId))
        .exec()) ?? [];
      return {
        global: Number(global?.[1] ?? 0),
        client: Number(client?.[1] ?? 0),
        available: true,
      };
    } catch (error) {
      this.log(error);
      return { global: 0, client: 0, available: false };
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensure();
      return (await this.redis.ping()) === "PONG";
    } catch (error) {
      this.log(error);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  private log(error: unknown): void {
    if (Date.now() - this.lastErrorAt > 5000) {
      this.lastErrorAt = Date.now();
      this.logger.warn(`Redis unavailable: ${(error as Error).message}`);
    }
  }
}
