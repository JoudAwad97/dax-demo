import AmazonDaxClient = require("amazon-dax-client");
import AWS from "aws-sdk";
import { REGION, DAX_ENDPOINT } from "./config";

AWS.config.update({ region: REGION });

/**
 * Direct-to-DynamoDB client (NO cache). Used for:
 *  - seeding the table,
 *  - the out-of-band "direct write" that makes DAX go stale,
 *  - a latency baseline (`?compare=1`).
 */
export const ddb = new AWS.DynamoDB.DocumentClient({ region: REGION });

// Accept any endpoint form and normalise to the `host:port` the v1 client wants:
//   "host"                      -> "host:8111"   (default unencrypted port)
//   "host:8111"                 -> unchanged
//   "dax://host:8111"           -> "host:8111"    (strip scheme)
function normalizeEndpoint(ep: string): string {
  const noScheme = ep.replace(/^daxs?:\/\//, "").trim();
  return /:\d+$/.test(noScheme) ? noScheme : `${noScheme}:8111`;
}

let cached: AWS.DynamoDB.DocumentClient | null = null;

/**
 * DAX-backed client — the SAME DocumentClient API, routed through the cluster.
 * Lazily created so commands that only need `ddb` (e.g. seeding) work even when
 * no DAX endpoint is configured.
 *
 * DAX has no local emulator: this REQUIRES a real cluster endpoint.
 */
export function dax(): AWS.DynamoDB.DocumentClient {
  if (cached) return cached;
  if (!DAX_ENDPOINT) {
    throw new Error(
      "DAX_ENDPOINT is not set. DAX has no local emulator — point it at your " +
        "cluster's discovery endpoint (CDK output `DaxEndpoint`, e.g. " +
        "dax://my-cluster.abc123.dax-clusters.us-east-1.amazonaws.com:8111).",
    );
  }
  const client = new AmazonDaxClient({ endpoints: [normalizeEndpoint(DAX_ENDPOINT)], region: REGION });
  cached = new AWS.DynamoDB.DocumentClient({ service: client });
  return cached;
}
