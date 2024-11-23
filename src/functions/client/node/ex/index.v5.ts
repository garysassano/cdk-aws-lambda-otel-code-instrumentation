import { initTelemetry, tracedHandler } from "@dev7a/lambda-otel-lite";
import { Context as LambdaContext } from "aws-lambda";
import { ScheduledEvent } from "aws-lambda";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";

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

// Initialize OpenTelemetry outside handler for cold start optimization
const { tracer, provider } = initTelemetry("quotes-function");

async function getRandomQuote(): Promise<Quote> {
  return tracer.startActiveSpan(
    "get_random_quote",
    { kind: SpanKind.CLIENT },
    async (span) => {
      try {
        const response = await fetch(QUOTES_URL);
        span.setAttributes({
          "http.url": QUOTES_URL,
          "http.method": "GET",
          "http.status_code": response.status,
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = (await response.json()) as Record<string, unknown>;
        if (
          typeof data.id !== "number" ||
          typeof data.quote !== "string" ||
          typeof data.author !== "string"
        ) {
          throw new Error("Invalid quote data received");
        }

        return { id: data.id, quote: data.quote, author: data.author };
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      }
    },
  );
}

async function saveQuote(quote: Quote): Promise<unknown> {
  return tracer.startActiveSpan(
    "save_quote",
    { kind: SpanKind.CLIENT },
    async (span) => {
      try {
        if (!TARGET_URL) {
          throw new Error("TARGET_URL environment variable is not set");
        }

        const response = await fetch(TARGET_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(quote),
        });

        span.setAttributes({
          "http.url": TARGET_URL,
          "http.method": "POST",
          "http.status_code": response.status,
          "quote.id": quote.id,
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        return await response.json();
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
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
    attributes: { "faas.trigger": "timer" },
    fn: async (span) => {
      try {
        const quote = await getRandomQuote();
        span.addEvent("Quote Fetched", { quote_id: quote.id });

        const savedResponse = await saveQuote(quote);
        span.addEvent("Quote Saved Successfully");

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
        span.setStatus({ code: SpanStatusCode.ERROR });

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
