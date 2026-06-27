import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as dax from "aws-cdk-lib/aws-dax";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";

const TABLE_NAME = "ProductCatalog";
const CATEGORY_INDEX = "category-index";

export class DaxDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---- network: public subnets (EC2 runner) + isolated subnets (DAX) -----
    // No NAT gateway: DAX reaches DynamoDB through a (free, in-VPC) DynamoDB
    // gateway endpoint instead, and the EC2 runner uses the IGW directly. This
    // also sidesteps the per-region NAT-gateway limit and cuts the demo's cost.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        Dynamo: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
      },
    });

    // ---- DynamoDB table (PK id) + GSI on category --------------------------
    const table = new dynamodb.Table(this, "Table", {
      tableName: TABLE_NAME,
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // demo: tear down cleanly
    });
    table.addGlobalSecondaryIndex({
      indexName: CATEGORY_INDEX,
      partitionKey: { name: "category", type: dynamodb.AttributeType.STRING },
    });

    // ---- security groups ---------------------------------------------------
    const appSg = new ec2.SecurityGroup(this, "AppSg", { vpc, description: "DAX demo EC2 runner" });
    const daxSg = new ec2.SecurityGroup(this, "DaxSg", { vpc, description: "DAX cluster" });
    daxSg.addIngressRule(appSg, ec2.Port.tcp(8111), "DAX data plane (unencrypted)");

    // ---- DAX: role (DAX -> DynamoDB), subnets, params (short TTL), cluster --
    const daxRole = new iam.Role(this, "DaxRole", {
      assumedBy: new iam.ServicePrincipal("dax.amazonaws.com"),
    });
    table.grantReadWriteData(daxRole);

    const subnetGroup = new dax.CfnSubnetGroup(this, "DaxSubnets", {
      subnetGroupName: "dax-demo-subnets",
      description: "DAX demo private subnets",
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    // Short TTLs so the staleness window is visible on camera. AWS default is
    // 300000 ms (5 minutes) for BOTH item and query caches; we use 60s here.
    const paramGroup = new dax.CfnParameterGroup(this, "DaxParams", {
      parameterGroupName: "dax-demo-params",
      description: "Short TTLs for the demo",
      parameterNameValues: {
        "record-ttl-millis": "60000",
        "query-ttl-millis": "60000",
      },
    });

    const cluster = new dax.CfnCluster(this, "DaxCluster", {
      clusterName: "dax-demo",
      nodeType: "dax.t3.small",
      replicationFactor: 1,
      iamRoleArn: daxRole.roleArn,
      subnetGroupName: subnetGroup.subnetGroupName as string,
      parameterGroupName: paramGroup.parameterGroupName,
      securityGroupIds: [daxSg.securityGroupId],
      clusterEndpointEncryptionType: "NONE",
    });
    cluster.addDependency(subnetGroup);
    cluster.addDependency(paramGroup);

    // ---- EC2 runner: in-VPC (can reach DAX), SSM-managed, app baked in -----
    const appAsset = new s3assets.Asset(this, "AppAsset", {
      path: path.join(__dirname, "..", "..", "app"),
      exclude: ["node_modules", "dist", ".env"],
    });

    const runnerRole = new iam.Role(this, "RunnerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    // Direct DynamoDB calls: seeding, the out-of-band write, the baseline read.
    table.grantReadWriteData(runnerRole);
    // DAX data-plane calls are SigV4-authenticated with `dax:*` actions.
    runnerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "dax:GetItem",
          "dax:BatchGetItem",
          "dax:Query",
          "dax:Scan",
          "dax:PutItem",
          "dax:UpdateItem",
          "dax:DeleteItem",
          "dax:BatchWriteItem",
          "dax:ConditionCheckItem",
        ],
        resources: [cluster.attrArn],
      }),
    );
    appAsset.grantRead(runnerRole);

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -eux",
      "dnf install -y nodejs npm unzip",
      "mkdir -p /opt/dax-demo",
      `aws s3 cp s3://${appAsset.s3BucketName}/${appAsset.s3ObjectKey} /tmp/app.zip --region ${this.region}`,
      "unzip -o /tmp/app.zip -d /opt/dax-demo",
      "cd /opt/dax-demo && (npm ci || npm install)",
      // pre-populate .env from stack values so `npm run seed` / `npm start` just work
      `printf 'AWS_REGION=%s\\nTABLE_NAME=%s\\nCATEGORY_INDEX=%s\\nDAX_ENDPOINT=%s\\nPORT=3000\\nHIT_THRESHOLD_MS=2\\n' ${this.region} ${TABLE_NAME} ${CATEGORY_INDEX} ${cluster.attrClusterDiscoveryEndpoint} > /opt/dax-demo/.env`,
      "chown -R ec2-user:ec2-user /opt/dax-demo",
    );

    const runner = new ec2.Instance(this, "Runner", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: appSg,
      role: runnerRole,
      userData,
      associatePublicIpAddress: true,
    });
    runner.node.addDependency(cluster);

    // ---- outputs -----------------------------------------------------------
    new cdk.CfnOutput(this, "DaxEndpoint", {
      value: cluster.attrClusterDiscoveryEndpoint,
      description: "Set DAX_ENDPOINT to this (already written to the runner's .env).",
    });
    new cdk.CfnOutput(this, "TableName", { value: TABLE_NAME });
    new cdk.CfnOutput(this, "RunnerInstanceId", { value: runner.instanceId });
    new cdk.CfnOutput(this, "SsmConnect", {
      value: `aws ssm start-session --target ${runner.instanceId}`,
      description: "Open a shell on the runner (no SSH key needed).",
    });
  }
}
