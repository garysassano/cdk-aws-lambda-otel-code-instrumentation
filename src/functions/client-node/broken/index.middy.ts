import { initTelemetry } from "@dev7a/lambda-otel-lite";
import middy from "@middy/core";
import type { Request } from "@middy/core";
import {
  Context as LambdaContext,
  ScheduledEvent,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  SpanKind,
  SpanStatusCode,
  Span,
  Attributes,
  trace,
} from "@opentelemetry/api";
import { z } from "zod";
import { validateEnv } from "../../../utils/validate-env";

//==============================================================================
// LAMBDA INITIALIZATION (COLD START)
//==============================================================================

// Initialize OpenTelemetry tracer
const { tracer, provider } = initTelemetry("quotes-function");

// Validate and get environment variables
const env = validateEnv(["TARGET_URL"]);

// Define API endpoints and configuration
const QUOTES_URL = "https://dummyjson.com/quotes/random";
const TARGET_URL = env.TARGET_URL;

// Define the schema for quote validation
const QuoteSchema = z.object({
  id: z.number(),
  quote: z.string(),
  author: z.string(),
});
type Quote = z.infer<typeof QuoteSchema>;

//==============================================================================
// MIDDY MIDDLEWARE
//==============================================================================

const otelTracing = (
  spanName: string,
  attributes: Attributes = {},
  kind = SpanKind.SERVER,
) => {
  let activeSpan: Span | undefined;

  return {
    before: async () => {
      return new Promise<void>((resolve) => {
        tracer.startActiveSpan(
          spanName,
          {
            kind,
            attributes,
          },
          (span) => {
            activeSpan = span;
            return new Promise<void>(() => {
              resolve();
            });
          },
        );
      });
    },
    after: async (request: Request) => {
      if (request.response && activeSpan) {
        activeSpan.setAttributes({
          "http.status_code": request.response.statusCode,
        });
      }
      activeSpan?.end();
      await provider.forceFlush();
    },
    onError: async (request: Request) => {
      if (request.error && activeSpan) {
        activeSpan.recordException(request.error);
        activeSpan.setStatus({ code: SpanStatusCode.ERROR });
      }
      activeSpan?.end();
      await provider.forceFlush();
      throw request.error;
    },
  };
};

//==============================================================================
// LAMBDA HANDLER
//==============================================================================

const lambdaHandler = async (
  _event: ScheduledEvent,
  _context: LambdaContext,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const span = trace.getActiveSpan();

  try {
    const quote = await getRandomQuote();
    span?.addEvent("Quote Fetched Successfully", { quote_id: quote.id });

    const savedResponse = await saveQuote(quote);
    span?.addEvent("Quote Saved Successfully", { quote_id: quote.id });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Quote Processed Successfully",
        quote,
        savedResponse,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Error processing quote",
        error: (error as Error).message,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  }
};

export const handler = middy(lambdaHandler).use(
  otelTracing("quotes-handler", { "faas.trigger": "timer" }),
);

//==============================================================================
// HELPER FUNCTIONS
//==============================================================================

/**
 * Fetches a random quote from the external API and validates its structure.
 *
 * @returns A validated Quote object
 * @throws Error if the API request fails or if the response doesn't match the schema
 */
async function getRandomQuote(): Promise<Quote> {
  return new Promise<Quote>((resolve, reject) => {
    tracer.startActiveSpan(
      "get_random_quote",
      {
        kind: SpanKind.CLIENT,
      },
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

          const data = await response.json();
          const quote = QuoteSchema.parse(data);
          resolve(quote);
          return quote;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          reject(error);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  });
}

/**
 * Saves a quote to the target endpoint with proper telemetry tracking.
 *
 * @param quote - The quote object to save
 * @returns The response from the target endpoint
 * @throws Error if the save operation fails
 */
async function saveQuote(quote: Quote): Promise<unknown> {
  return new Promise((resolve, reject) => {
    tracer.startActiveSpan(
      "save_quote",
      {
        kind: SpanKind.CLIENT,
      },
      async (span) => {
        try {
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

          const result = await response.json();
          resolve(result);
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          reject(error);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  });
}
