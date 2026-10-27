import "reflect-metadata";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { env } from "./config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableCors({
    origin: env.corsOrigins.length > 0 ? env.corsOrigins : true,
    methods: ["GET", "POST", "OPTIONS"],
  });
  app.enableShutdownHooks();
  await app.listen(env.port, "0.0.0.0");
  Logger.log(
    `API listening on http://localhost:${env.port}/api (AWS endpoint: ${env.endpoint || "default"})`,
    "Bootstrap",
  );
}

void bootstrap();
