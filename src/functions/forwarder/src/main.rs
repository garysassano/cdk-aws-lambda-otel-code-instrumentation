//! AWS Lambda function that forwards CloudWatch log wrapped OTLP records to OpenTelemetry collectors.
//!
//! This Lambda function:
//! 1. Receives CloudWatch log events as otlp-stout format
//! 2. Decodes and decompresses the log data
//! 3. Converts logs to TelemetryData
//! 4. Forwards the data to collectors in parallel
//!
//! The function supports:
//! - Multiple collectors with different endpoints
//! - Custom headers and authentication
//! - Base64 encoded payloads
//! - Gzip compressed data
//! - OpenTelemetry instrumentation

use anyhow::{Context, Result};
use aws_credential_types::provider::ProvideCredentials;
use aws_lambda_events::event::cloudwatch_logs::LogEntry;
use lambda_otlp_forwarder::{
    AppState, LogsEventWrapper,
    collectors::Collectors,
    processing::process_telemetry_batch,
    span_compactor::{SpanCompactionConfig, compact_telemetry_payloads},
    telemetry::TelemetryData,
};
use otlp_sigv4_client::SigV4ClientBuilder;
use otlp_stdout_span_exporter::ExporterOutput;
use serde_json::Value;
use std::collections::HashMap;

use lambda_otel_lite::{OtelTracingLayer, TelemetryConfig, init_telemetry};

use opentelemetry_otlp::{Protocol, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::trace::BatchSpanProcessor;

use lambda_runtime::{Error as LambdaError, LambdaEvent, Runtime, tower::ServiceBuilder};
use std::sync::Arc;
/// Convert a CloudWatch log event into TelemetryData
fn convert_log_event(event: &LogEntry) -> Result<TelemetryData> {
    let record = &event.message;

    tracing::debug!("Received log record: {}", record);

    // Parse the JSON into a serde_json::Value first
    let json_value: Value = serde_json::from_str(record)
        .with_context(|| format!("Failed to parse log record as JSON: {}", record))?;

    // Extract fields from the JSON, handling different field names and versions
    let version = json_value
        .get("__otel_otlp_stdout")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    let source = json_value
        .get("source")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| "unknown".to_string());

    let endpoint = json_value
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or("http://localhost:4318/v1/traces");

    let method = json_value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("POST");

    // Check both kebab-case and snake_case variants for content type
    let content_type = json_value
        .get("content-type")
        .or_else(|| json_value.get("content_type"))
        .and_then(Value::as_str)
        .unwrap_or("application/x-protobuf");

    // Same for content encoding
    let content_encoding = json_value
        .get("content-encoding")
        .or_else(|| json_value.get("content_encoding"))
        .and_then(Value::as_str)
        .unwrap_or("gzip");

    // Extract headers if present
    let mut headers = HashMap::new();
    if let Some(headers_obj) = json_value.get("headers").and_then(Value::as_object) {
        for (key, value) in headers_obj {
            if let Some(value_str) = value.as_str() {
                headers.insert(key.clone(), value_str.to_string());
            }
        }
    }

    // Get payload and base64 flag
    let payload = json_value
        .get("payload")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_default();

    let base64 = json_value
        .get("base64")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    // Create ExporterOutput with borrowed references where required
    let exporter_output = ExporterOutput {
        version,
        source,
        endpoint,
        method,
        content_type,
        content_encoding,
        headers,
        payload,
        base64,
    };

    tracing::debug!("Successfully parsed log record with version: {}", version);

    // Convert to TelemetryData (will be in uncompressed protobuf format)
    TelemetryData::from_log_record(exporter_output)
}

async fn function_handler(
    event: LambdaEvent<LogsEventWrapper>,
    state: Arc<AppState>,
) -> Result<(), LambdaError> {
    tracing::debug!("Function handler started");

    // Check and refresh collectors cache if stale
    Collectors::init(&state.secrets_client).await?;

    let log_events = event.payload.0.aws_logs.data.log_events;

    // Convert all events to TelemetryData (sequentially)
    let telemetry_batch: Vec<TelemetryData> = log_events
        .iter()
        .filter_map(|event| match convert_log_event(event) {
            Ok(telemetry) => Some(telemetry),
            Err(e) => {
                tracing::warn!("Failed to convert span event: {}", e);
                None
            }
        })
        .collect();

    // If we have telemetry data, process it
    if !telemetry_batch.is_empty() {
        // Compact multiple payloads into a single one
        // This will also apply compression to the final result
        let compacted_telemetry =
            match compact_telemetry_payloads(telemetry_batch, &SpanCompactionConfig::default()) {
                Ok(telemetry) => vec![telemetry],
                Err(e) => {
                    tracing::error!("Failed to compact telemetry payloads: {}", e);
                    return Err(e);
                }
            };

        // Process the compacted telemetry (single POST request)
        process_telemetry_batch(
            compacted_telemetry,
            &state.http_client,
            &state.credentials,
            &state.region,
        )
        .await?;
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), LambdaError> {
    let config = aws_config::load_from_env().await;
    let region = config.region().expect("No region found");
    let credentials = config
        .credentials_provider()
        .expect("No credentials provider found")
        .provide_credentials()
        .await?;

    let sigv4_client = SigV4ClientBuilder::new()
        .with_client(
            reqwest::blocking::Client::builder()
                .build()
                .map_err(|e| LambdaError::from(format!("Failed to build HTTP client: {}", e)))?,
        )
        .with_credentials(credentials)
        .with_region(region.to_string())
        .with_service("xray")
        .with_signing_predicate(Box::new(|request| {
            // Only sign requests to AWS endpoints
            if let Some(host) = request.uri().host() {
                host.ends_with(".amazonaws.com")
            } else {
                false
            }
        }))
        .build()?;

    // Create a new exporter for BatchSpanProcessor
    let batch_exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_http_client(sigv4_client)
        .with_protocol(Protocol::HttpBinary)
        .with_timeout(std::time::Duration::from_secs(3))
        .build()?;

    let (_, completion_handler) = init_telemetry(
        TelemetryConfig::builder()
            .with_span_processor(BatchSpanProcessor::builder(batch_exporter).build())
            .build(),
    )
    .await?;

    // Initialize shared application state
    let state = Arc::new(AppState::new().await?);

    // Initialize collectors using state's secrets client
    Collectors::init(&state.secrets_client).await?;

    let service = ServiceBuilder::new()
        .layer(OtelTracingLayer::new(completion_handler))
        .service_fn(|event| {
            let state = Arc::clone(&state);
            async move { function_handler(event, state).await }
        });

    // Create and run the Lambda runtime
    let runtime = Runtime::new(service);
    runtime.run().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose};
    use flate2::{Compression, write::GzEncoder};
    use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
    use prost::Message;
    use serde_json::json;
    use std::io::Write;

    // Helper function to create gzipped, base64-encoded protobuf data
    fn create_test_payload() -> String {
        // Create a minimal valid OTLP protobuf payload
        let request = ExportTraceServiceRequest {
            resource_spans: vec![],
        };

        // Convert to protobuf bytes
        let proto_bytes = request.encode_to_vec();

        // Compress with gzip
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&proto_bytes).unwrap();
        let compressed_bytes = encoder.finish().unwrap();

        // Base64 encode
        general_purpose::STANDARD.encode(compressed_bytes)
    }

    #[test]
    fn test_convert_log_event() {
        // Test standard LogRecord with valid OTLP structure
        let log_record = json!({
            "__otel_otlp_stdout": "otlp-stdout-span-exporter@0.2.2",
            "source": "test-service",
            "endpoint": "http://example.com",
            "method": "POST",
            "payload": create_test_payload(),
            "headers": {
                "content-type": "application/x-protobuf"
            },
            "content-type": "application/x-protobuf",
            "content-encoding": "gzip",
            "base64": true
        });

        let event = LogEntry {
            id: "test-id".to_string(),
            timestamp: 1234567890,
            message: serde_json::to_string(&log_record).unwrap(),
        };

        let result = convert_log_event(&event);
        if let Err(e) = &result {
            println!("Error converting log event: {}", e);
        }
        assert!(result.is_ok());
        let telemetry = result.unwrap();
        assert_eq!(telemetry.source, "test-service");
        assert_eq!(telemetry.content_type, "application/x-protobuf"); // Now converted to protobuf
        assert_eq!(telemetry.content_encoding, None); // No compression at this stage
    }
}
