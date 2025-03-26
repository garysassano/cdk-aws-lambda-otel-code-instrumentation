import { initTelemetry, tracedHandler } from "@dev7a/lambda-otel-lite";
import { Context as LambdaContext } from "aws-lambda";
import { ScheduledEvent } from "aws-lambda";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { StdoutOTLPExporterNode } from "@dev7a/otlp-stdout-exporter";

// Constants
const QUOTES_URL = "https://dummyjson.com/quotes/random";
const TARGET_URL = process.env.TARGET_URL;

// Types
interface Quote {
  id: number;
  quote: string;
  author: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

// Type guard moved outside handler for cold start optimization
function isQuote(obj: any): obj is Quote {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof obj.id === "number" &&
    typeof obj.quote === "string" &&
    typeof obj.author === "string"
  );
}

// Initialize OpenTelemetry with Lambda-optimized settings
const { tracer, provider } = initTelemetry("quotes-function", {
  spanProcessor: new BatchSpanProcessor(new StdoutOTLPExporterNode(), {
    maxQueueSize: parseInt(
      process.env.LAMBDA_SPAN_PROCESSOR_QUEUE_SIZE || "2048",
    ),
    scheduledDelayMillis: 1000,
    maxExportBatchSize: 512,
  }),
});

async function getRandomQuote(): Promise<Quote> {
  return tracer.startActiveSpan(
    "get_random_quote",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.url": QUOTES_URL,
        "http.method": "GET",
      },
    },
    async (span) => {
      try {
        const response = await fetch(QUOTES_URL);
        span.setAttribute("http.status_code", response.status);

        if (!response.ok) {
          const error = new Error(`HTTP error! status: ${response.status}`);
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `Failed with status ${response.status}`,
          });
          throw error;
        }

        const data = await response.json();
        if (!isQuote(data)) {
          const error = new Error("Invalid quote data received");
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "Data validation failed",
          });
          throw error;
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return data;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });
        throw error;
      } finally {
        // Ensure span ends even if there's an error
        span.end();
      }
    },
  );
}

async function saveQuote(quote: Quote): Promise<any> {
  return tracer.startActiveSpan(
    "save_quote",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.method": "POST",
        "quote.id": quote.id,
        "quote.author": quote.author,
      },
    },
    async (span) => {
      try {
        if (!TARGET_URL) {
          const error = new Error("TARGET_URL environment variable is not set");
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "Missing configuration",
          });
          throw error;
        }

        span.setAttribute("http.url", TARGET_URL);

        const response = await fetch(TARGET_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(quote),
        });

        span.setAttribute("http.status_code", response.status);

        if (!response.ok) {
          const error = new Error(`HTTP error! status: ${response.status}`);
          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `Failed with status ${response.status}`,
          });
          throw error;
        }

        const result = await response.json();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export const handler = async (
  event: ScheduledEvent,
  context: LambdaContext,
): Promise<LambdaResponse> => {
  return tracedHandler({
    tracer,
    provider,
    name: "quotes-handler",
    event,
    context,
    kind: SpanKind.SERVER,
    attributes: {
      "faas.trigger": "timer",
      "faas.invocation": context.awsRequestId,
    },
    fn: async (span) => {
      try {
        const quote = await getRandomQuote();
        span.addEvent("Quote Fetched", {
          quote_id: quote.id,
          quote_author: quote.author,
          timestamp: Date.now(),
        });

        const savedResponse = await saveQuote(quote);
        span.addEvent("Quote Saved Successfully", {
          timestamp: Date.now(),
        });

        span.setStatus({ code: SpanStatusCode.OK });
        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "Quote processed successfully",
            quote,
            savedResponse,
          }),
        };
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });

        return {
          statusCode: 500,
          body: JSON.stringify({
            message: "Error processing quote",
            error: (error as Error).message,
          }),
        };
      }
    },
  });
};
