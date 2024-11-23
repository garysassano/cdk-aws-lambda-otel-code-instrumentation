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

// Add a type guard to validate Quote object
function isQuote(obj: any): obj is Quote {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof obj.id === "number" &&
    typeof obj.quote === "string" &&
    typeof obj.author === "string"
  );
}

// Initialize OpenTelemetry outside the handler (best practice)
const { tracer, provider } = initTelemetry("quotes-function");

/**
 * Fetches a random quote from the quotes API
 */
async function getRandomQuote(): Promise<Quote> {
  return tracer.startActiveSpan(
    "get_random_quote",
    { kind: SpanKind.CLIENT },
    async (span) => {
      try {
        const response = await fetch(QUOTES_URL);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();

        if (!isQuote(data)) {
          throw new Error("Invalid quote data received");
        }

        span.setAttribute("http.status_code", response.status);
        span.setAttribute("http.url", QUOTES_URL);
        span.setAttribute("http.method", "GET");
        return data;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      }
    },
  );
}

/**
 * Saves a quote to the target service
 */
async function saveQuote(quote: Quote): Promise<any> {
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
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(quote),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        span.setAttribute("http.status_code", response.status);
        span.setAttribute("http.url", TARGET_URL);
        span.setAttribute("http.method", "POST");
        return await response.json();
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      }
    },
  );
}

/**
 * Lambda handler function for scheduled events
 */
export const handler = async (
  event: ScheduledEvent,
  context: LambdaContext,
): Promise<LambdaResponse> => {
  return tracedHandler({
    tracer,
    provider,
    name: "quotes-handler",
    event, // Enable automatic FAAS attributes from event
    context, // Enable automatic FAAS attributes from context
    kind: SpanKind.SERVER,
    attributes: {
      "faas.trigger": "timer",
    },
    fn: async (span) => {
      try {
        // Get and save quote
        const quote = await getRandomQuote();
        span.addEvent("Quote Fetched", {
          quote_id: quote.id,
          quote_author: quote.author,
        });

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
