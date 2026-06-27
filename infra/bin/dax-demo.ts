#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { DaxDemoStack } from "../lib/dax-demo-stack";

const app = new cdk.App();

new DaxDemoStack(app, "DaxDemoStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description:
    "DynamoDB + DAX REST demo: VPC, DAX cluster (short TTL), ProductCatalog table, and an SSM-managed EC2 runner with the API baked in.",
});
