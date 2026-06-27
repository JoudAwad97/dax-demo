// amazon-dax-client is a CommonJS module (declared `export =` in
// types/amazon-dax-client.d.ts) imported as a default here via esModuleInterop.
// It only works against the aws-sdk v2 DocumentClient — there is no official
// v3-compatible DAX client, so don't port this onto @aws-sdk/* without
// replacing DAX itself.
import AmazonDaxClient from "amazon-dax-client";
import AWS from "aws-sdk";
import { REGION, DAX_ENDPOINT } from "./config";

AWS.config.update({ region: REGION });

/** Direct-to-DynamoDB client (NO cache): seeding, the out-of-band "direct
 *  write" that makes DAX go stale, and the `?compare=1` latency baseline. */
export const ddb = new AWS.DynamoDB.DocumentClient();

/**
 * DAX-backed client — the SAME DocumentClient API, routed through the cluster.
 * Built once, lazily, so commands that only need `ddb` (e.g. seeding) work even
 * when no endpoint is set. DAX_ENDPOINT is used verbatim: the CDK output
 * `DaxEndpoint` is a `host:port` discovery endpoint, and the client also accepts
 * the `dax://host:port` form. DAX has no local emulator — a real cluster is required.
 */
let cached: AWS.DynamoDB.DocumentClient | undefined;

export function dax(): AWS.DynamoDB.DocumentClient {
  if (!DAX_ENDPOINT) {
    throw new Error(
      "DAX_ENDPOINT is not set. DAX has no local emulator — point it at the " +
        "cluster discovery endpoint (CDK output `DaxEndpoint`).",
    );
  }
  return (cached ??= new AWS.DynamoDB.DocumentClient({
    service: new AmazonDaxClient({ endpoints: [DAX_ENDPOINT], region: REGION }),
  }));
}
