import { z } from "zod";
import { API_OPERATIONS, type ApiOperation } from "./operations";
import { API_SCOPES } from "./scopes";

type JsonSchema = Record<string, unknown>;

const schemaOf = (schema: z.ZodType, io: "input" | "output"): JsonSchema => {
  const json = z.toJSONSchema(schema, {
    io,
    unrepresentable: "any",
  }) as JsonSchema;
  delete json.$schema;
  return json;
};

function parameters(op: ApiOperation) {
  const list: JsonSchema[] = [];
  for (const [name, schema] of Object.entries(op.params?.shape ?? {}))
    list.push({
      name,
      in: "path",
      required: true,
      schema: schemaOf(schema as z.ZodType, "input"),
    });
  for (const [name, schema] of Object.entries(op.query.shape)) {
    const json = schemaOf(schema as z.ZodType, "input");
    const required = !(schema as z.ZodType).safeParse(undefined).success;
    list.push({
      name,
      in: "query",
      required,
      ...(json.description ? { description: json.description } : {}),
      schema: json,
    });
  }
  if (op.idempotent)
    list.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description:
        "A new uuid per create. A retry with the same key and body replays the first answer.",
      schema: { type: "string", format: "uuid" },
    });
  return list;
}

const errorEnvelope = {
  type: "object",
  required: ["success", "error", "request_id"],
  properties: {
    success: { const: false },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: {
          type: "string",
          enum: [
            "UNAUTHORIZED",
            "FORBIDDEN",
            "NOT_FOUND",
            "VALIDATION_ERROR",
            "CONFLICT",
            "RATE_LIMIT_EXCEEDED",
            "INTERNAL_ERROR",
          ],
        },
        message: { type: "string" },
        details: {
          type: "object",
          description:
            "reason is a stable machine-readable cause; hint says what to change.",
          properties: { reason: { type: "string" }, hint: { type: "string" } },
        },
      },
    },
    request_id: { type: "string", format: "uuid" },
  },
};

/** OpenAPI 3.1 for the finance API, generated from the operation registry. */
export function openApiDocument(origin: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of API_OPERATIONS as readonly ApiOperation[]) {
    paths[op.path] ??= {};
    paths[op.path][op.method.toLowerCase()] = {
      operationId: op.id,
      tags: [op.tag],
      summary: op.summary,
      description: `${op.description}\n\nRequires scope \`${op.permission}\`, on the key and held by its member. Source: ${op.source}.`,
      security: [{ apiKey: [] }],
      parameters: parameters(op),
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: schemaOf(op.body, "input") },
              },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["success", "source", "data", "request_id"],
                properties: {
                  success: { const: true },
                  source: { const: op.source },
                  data: schemaOf(op.response, "output"),
                  request_id: { type: "string", format: "uuid" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Error" },
        "403": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
        "422": { $ref: "#/components/responses/Error" },
        "429": { $ref: "#/components/responses/Error" },
        ...(op.method === "GET"
          ? {}
          : { "409": { $ref: "#/components/responses/Error" } }),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Valiance Media finance API",
      version: "1.0.0",
      description: [
        "Access to the books and the owner's trackers. Books writes are drafts only: nothing an agent writes reaches the official numbers until the owner reviews and posts it in the app.",
        "Money is integer cents as strings. `source` says where numbers come from: `books` (the official business figures), `tracker` (the owner's manual records) or `estimate` (the tax estimator).",
        "Every key belongs to one team member and works only for scopes that are both on the key and held by that member. 120 requests a minute per key.",
        `Scopes: ${API_SCOPES.map((scope) => `\`${scope.key}\` (${scope.label})`).join(", ")}.`,
      ].join("\n\n"),
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "Also accepted as Authorization: Bearer <key>.",
        },
      },
      responses: {
        Error: {
          description: "Error",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
    paths,
  };
}
