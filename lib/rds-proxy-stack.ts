import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';

export class RdsProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const vpc = new ec2.Vpc(this,'MyVPC',{
      maxAzs: 2,
    });

    const lambdaSecurityGroup = new ec2.SecurityGroup(this,'lambdaSecurityGroup',{
      vpc,
    });

    const rdsSecurityGroup = new ec2.SecurityGroup(this,'rdsSecurityGroup',{
      vpc,
    });

    rdsSecurityGroup.addIngressRule(lambdaSecurityGroup,ec2.Port.tcp(5432),'Allow Lambda to Access RDS');

    const dbCredentialsSecret = new secretsmanager.Secret(this,'DBCredentilasSecret',{
      secretName: 'dbCredentials',
      generateSecretString:{
        secretStringTemplate: JSON.stringify({username:'databaseAdmin'}),
        excludePunctuation: true,
        includeSpace:false,
        generateStringKey: 'password',
      },
    })

    const writerInstance = rds.ClusterInstance.provisioned('writer-instance', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      instanceIdentifier: 'writer-instance',
    })

    // Create an Aurora PostgreSQL-Compatible Cluster
    const cluster = new rds.DatabaseCluster(this, 'AuroraPostgresCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_1}),
      vpc: vpc,
      clusterIdentifier: 'myDatabase',
      writer: writerInstance,
      defaultDatabaseName: 'mydatabase',
      credentials: rds.Credentials.fromSecret(dbCredentialsSecret),
      securityGroups: [rdsSecurityGroup],
    })

    const rdsProxy =  new rds.DatabaseProxy(this, 'RdsProxy',{
      proxyTarget: rds.ProxyTarget.fromCluster(cluster),
      secrets: [dbCredentialsSecret],
      vpc,
      securityGroups: [rdsSecurityGroup],
      requireTLS:false,
    })

    const myLambda = new lambda.Function(this, 'MyLambdaFunction',{
      runtime: lambda.Runtime.NODEJS_16_X,
      handler: 'index.handler',
      code:lambda.Code.fromAsset('lambda'),
      vpc,
      securityGroups: [lambdaSecurityGroup],
      environment:{
        DB_HOST: rdsProxy.endpoint,
        DB_NAME: 'mydatabase',
        DB_USER: 'databaseAdmin',
        DB_PASSWORD: dbCredentialsSecret.secretValueFromJson('password').unsafeUnwrap(),
      },
    });

    dbCredentialsSecret.grantRead(myLambda);

    const api = new apigateway.RestApi(this, 'MyApi',{
      restApiName:'My Service',
      description: 'This service triggers my Lambda',
    });

    const getLambdaIntegration = new apigateway.LambdaIntegration(myLambda,{
      requestTemplates: {'application/json':'{"statusCode":"200"}'},
    });

    const resource = api.root.addResource('myLambda');
    resource.addMethod('GET',getLambdaIntegration);
  }
}
