import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { CreateJobDto } from "./jobs/dto";
import { JobsService } from "./jobs/jobs.service";

@Controller("jobs")
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(@Body() dto: CreateJobDto) {
    const job = await this.jobs.createJob(dto);
    return { job };
  }

  @Get()
  async list(@Query("clientId") clientId?: string) {
    if (!clientId) {
      throw new BadRequestException("clientId is required");
    }
    const [jobs, limits] = await Promise.all([
      this.jobs.listJobs(clientId),
      this.jobs.limits(clientId),
    ]);
    return { jobs, limits, serverTime: new Date().toISOString() };
  }

  @Get(":jobId")
  async detail(@Param("jobId") jobId: string) {
    return this.jobs.getJobDetail(jobId);
  }

  @Get(":jobId/download")
  async download(@Param("jobId") jobId: string, @Res() res: Response): Promise<void> {
    const url = await this.jobs.downloadUrl(jobId);
    res.redirect(HttpStatus.FOUND, url);
  }

  @Get(":jobId/email")
  async email(@Param("jobId") jobId: string) {
    return this.jobs.getStoredEmail(jobId);
  }

  @Post(":jobId/retry")
  @HttpCode(HttpStatus.ACCEPTED)
  async retry(@Param("jobId") jobId: string) {
    return { job: await this.jobs.retryJob(jobId) };
  }
}
