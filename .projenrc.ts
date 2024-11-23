import { awscdk, javascript } from "projen";

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: "2.173.4",
  defaultReleaseBranch: "main",
  depsUpgradeOptions: { workflow: false },
  devDeps: ["zod"],
  eslint: true,
  gitignore: ["**/target"],
  minNodeVersion: "22.12.0",
  name: "cdk-aws-lambda-otel-code-instrumentation",
  packageManager: javascript.NodePackageManager.PNPM,
  pnpmVersion: "9",
  prettier: true,
  projenrcTs: true,

  deps: [
    // "@aws-cdk/aws-lambda-python-alpha",
    "@aws-cdk/aws-scheduler-alpha",
    "@aws-cdk/aws-scheduler-targets-alpha",
    "@dev7a/otlp-stdout-exporter",
    "@opentelemetry/api",
    "@opentelemetry/core",
    "@opentelemetry/instrumentation",
    "@opentelemetry/instrumentation-undici",
    "@opentelemetry/otlp-exporter-base",
    "@opentelemetry/resource-detector-aws",
    "@opentelemetry/resources",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/sdk-trace-node",
    "@opentelemetry/semantic-conventions",
    "@types/aws-lambda",
    "cargo-lambda-cdk",
    "uv-python-lambda",
  ],
});

project.synth();
