import { initTelemetry, tracedHandler } from "@dev7a/lambda-otel-lite";
import {
  Context as LambdaContext,
  ScheduledEvent,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { SpanKind, SpanStatusCode, Span } from "@opentelemetry/api";
import { z } from "zod";
import { validateEnv } from "../../../utils/validate-env";

//==============================================================================
// LAMBDA INITIALIZATION (COLD START)
//==============================================================================

// Initialize OpenTelemetry tracer and provider
const { tracer, provider } = initTelemetry("quotes-function");

// Define API endpoints
const QUOTES_URL = "https://dummyjson.com/quotes/random";
const { TARGET_URL } = validateEnv(["TARGET_URL"]);

// Define the schema for quote validation
const QuoteSchema = z.object({
  id: z.number(),
  quote: z.string(),
  author: z.string(),
});
type Quote = z.infer<typeof QuoteSchema>;

//==============================================================================
// LAMBDA HANDLER
//==============================================================================

async function lambdaHandler(
  span: Span,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const quote = await getRandomQuote();
    span.addEvent("Quote Fetched Successfully", { quote_id: quote.id });

    const savedResponse = await saveQuote(quote);
    span.addEvent("Quote Saved Successfully", { quote_id: quote.id });

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
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });

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
}

export const handler = async (
  event: ScheduledEvent,
  context: LambdaContext,
): Promise<APIGatewayProxyStructuredResultV2> => {
  return tracedHandler({
    fn: lambdaHandler,
    name: "lambda-handler",
    attributes: { "faas.trigger": "timer" },
    tracer,
    provider,
    event,
    context,
  });
};

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
  const span = tracer.startSpan("get_random_quote", { kind: SpanKind.CLIENT });

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
    return QuoteSchema.parse(data);
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Saves a quote to the target endpoint with proper telemetry tracking.
 *
 * @param quote - The quote object to save
 * @returns The response from the target endpoint
 * @throws Error if the save operation fails
 */
async function saveQuote(quote: Quote): Promise<unknown> {
  const span = tracer.startSpan("save_quote", { kind: SpanKind.CLIENT });

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

    return await response.json();
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
