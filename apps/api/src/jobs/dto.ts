import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import type { OrderStatus } from "../types";

const STATUSES: OrderStatus[] = ["confirmed", "paid", "packing", "shipped"];

export class CreateJobDto {
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  orderIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  email?: string;
}

export class MutateOrderDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: OrderStatus;

  @IsOptional()
  @IsBoolean()
  bumpRev?: boolean;

  @IsOptional()
  @IsInt()
  @Min(-50)
  @Max(50)
  qtyDelta?: number;
}
