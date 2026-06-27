// Load .env (the CDK runner writes one; locally, copy .env.example). Must run
// before reading process.env below.
import "dotenv/config";

// Runtime config, read from the environment (.env on the EC2 runner).
export const REGION = process.env.AWS_REGION ?? "us-east-1";
export const TABLE_NAME = process.env.TABLE_NAME ?? "ProductCatalog";
export const CATEGORY_INDEX = process.env.CATEGORY_INDEX ?? "category-index";
export const DAX_ENDPOINT = process.env.DAX_ENDPOINT ?? "";
export const PORT = Number(process.env.PORT ?? 3000);

// Latency cutoff (ms) below which a DAX read is treated as a cache hit. DAX
// exposes no hit/miss flag, so we infer it: a hit is sub-millisecond, a miss
// (DAX -> DynamoDB) is several ms.
export const HIT_THRESHOLD_MS = Number(process.env.HIT_THRESHOLD_MS ?? 2);
