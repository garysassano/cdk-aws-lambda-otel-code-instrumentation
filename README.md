# cdk-aws-otlp-forwarder-cwl-lambda

CDK app showcasing an OTLP forwarder that sends traces via OTLP to any OTel-compatible vendor.

### Related Apps

- [cdk-aws-otlp-forwarder-kinesis-lambda] - WIP
- [serverless-otlp-forwarder](https://github.com/dev7a/serverless-otlp-forwarder) - Built with AWS SAM instead of CDK; this is what the app is based on.

## Prerequisites

- **_AWS:_**
  - Must have authenticated with [Default Credentials](https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli_auth) in your local environment.
  - Must have completed the [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) for the target AWS environment.
- **_OTel Vendor:_**
  - Must have set the `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` variables in your local environment.
- **_Node.js + npm:_**
  - Must be [installed](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) in your system.
- **_Docker:_**
  - Must be [installed](https://docs.docker.com/get-docker/) in your system and running at deployment.

## Installation

```sh
npx projen install
```

## Deployment

```sh
npx projen deploy
```

## Cleanup

```sh
npx projen destroy
```

## Application Diagram

![Application Diagram](./src/assets/app-diagram.svg)

## OpenTelemetry Diagram

![OpenTelemetry Diagram](./src/assets/otel-diagram.svg)
