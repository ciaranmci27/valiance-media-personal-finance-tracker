import Link from "next/link";
import { headers } from "next/headers";
import { ArrowLeft, BookOpen } from "lucide-react";
import { z } from "zod";
import {
  MobileMenuButton,
  HeaderControls,
} from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AccessDenied } from "@/components/features/access-denied";
import { canAccess } from "@/lib/team/access";
import { API_OPERATIONS, type ApiOperation } from "@/lib/api/operations";
import { API_SCOPES } from "@/lib/api/scopes";
import { MCP_TOOLS } from "@/lib/mcp/tools";

export const metadata = {
  title: "API reference",
};

interface Parameter {
  name: string;
  where: "path" | "query" | "body" | "header";
  required: boolean;
  type: string;
  description: string;
}

/** Parameters straight from the operation's schemas, as withApi parses them. */
function parametersOf(op: ApiOperation): Parameter[] {
  const describe = (
    name: string,
    schema: z.ZodType,
    where: Parameter["where"],
  ): Parameter => {
    const json = z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
    }) as {
      type?: string;
      enum?: unknown[];
      format?: string;
      default?: unknown;
      description?: string;
      pattern?: string;
    };
    const type = json.enum
      ? json.enum.join(" | ")
      : json.format === "uuid"
        ? "uuid"
        : json.pattern === "^\\d{4}-\\d{2}-\\d{2}$"
          ? "date (YYYY-MM-DD)"
          : (json.type ?? "string");
    const fallback =
      json.default !== undefined && !/default/i.test(json.description ?? "")
        ? `Default ${String(json.default)}.`
        : "";
    return {
      name,
      where,
      required: !schema.safeParse(undefined).success,
      type,
      description: [json.description, fallback].filter(Boolean).join(" "),
    };
  };
  return [
    ...Object.entries(op.params?.shape ?? {}).map(([name, schema]) =>
      describe(name, schema as z.ZodType, "path"),
    ),
    ...Object.entries(op.query.shape).map(([name, schema]) =>
      describe(name, schema as z.ZodType, "query"),
    ),
    ...Object.entries(op.body?.shape ?? {}).map(([name, schema]) =>
      describe(name, schema as z.ZodType, "body"),
    ),
    ...(op.idempotent
      ? [
          {
            name: "Idempotency-Key",
            where: "header" as const,
            required: true,
            type: "uuid",
            description:
              "A new uuid per create. A retry with the same key and body replays the first answer.",
          },
        ]
      : []),
  ];
}

/** Descriptions mark code with backticks (OpenAPI renders them as Markdown); show those parts as code here too. */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="font-mono text-foreground">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {children}
      </h2>
      <div className="flex-1 h-px bg-border/50" />
    </div>
  );
}

const ERRORS = [
  [
    "401",
    "UNAUTHORIZED",
    "missing_api_key, invalid_api_key, api_key_expired, api_key_disabled",
  ],
  [
    "403",
    "FORBIDDEN",
    "missing_key_scope, missing_member_permission, member_no_api, member_inactive",
  ],
  ["404", "NOT_FOUND", "not_found"],
  [
    "422",
    "VALIDATION_ERROR",
    "invalid_parameters, invalid_range, invalid_format",
  ],
  ["429", "RATE_LIMIT_EXCEEDED", "rate_limited (see Retry-After)"],
];

export default async function ApiReferencePage() {
  if (!(await canAccess("api.use")))
    return <AccessDenied area="API reference" />;
  const operations = API_OPERATIONS as readonly ApiOperation[];
  const tags = [...new Set(operations.map((op) => op.tag))];
  const toolFor = (op: ApiOperation) =>
    MCP_TOOLS.find((tool) => tool.operation?.id === op.id)?.definition.name;
  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "localhost";
  const protocol =
    head.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const mcpUrl = `${protocol}://${host}/api/mcp`;

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-y-2">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <BookOpen className="h-5 w-5 text-teal-light" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">API reference</h1>
            <p className="text-sm text-muted-foreground">
              Generated from the same list the server enforces.
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/settings/api">
            <Button size="sm" className="rounded-xl gap-1">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Keys
            </Button>
          </Link>
          <HeaderControls />
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>Basics</SectionTitle>
        <div className="glass-card rounded-xl p-6 space-y-3 text-sm text-muted-foreground">
          <p>
            Send your key in the{" "}
            <code className="font-mono text-foreground">x-api-key</code> header
            (or{" "}
            <code className="font-mono text-foreground">
              Authorization: Bearer
            </code>
            ). A key works only for scopes that are both on the key and held by
            the person it belongs to. 120 requests a minute per key; the{" "}
            <code className="font-mono text-foreground">X-RateLimit-*</code>{" "}
            headers show what is left.
          </p>
          <p>
            Money is integer cents as a string:{" "}
            <code className="font-mono text-foreground">&quot;12345&quot;</code>{" "}
            is $123.45. Every answer says where its numbers come from in{" "}
            <code className="font-mono text-foreground">source</code>:{" "}
            <strong className="text-foreground">books</strong> (the official
            business figures),{" "}
            <strong className="text-foreground">tracker</strong> (your manual
            records) or <strong className="text-foreground">estimate</strong>{" "}
            (the tax estimator). Books reads default to working mode, which
            includes transactions not yet reviewed, as the screens do; check{" "}
            <code className="font-mono text-foreground">quality</code> before
            treating numbers as final.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-[rgba(var(--ink),0.06)] p-3 font-mono text-xs text-foreground">{`{ "success": true, "source": "books", "data": { ... }, "request_id": "..." }
{ "success": false, "error": { "code": "FORBIDDEN", "message": "...", "details": { "reason": "missing_key_scope", "hint": "..." } }, "request_id": "..." }`}</pre>
          <p>
            Machine-readable spec:{" "}
            <a
              className="text-teal-light underline-offset-4 hover:underline"
              href="/api/v1/openapi.json"
            >
              /api/v1/openapi.json
            </a>{" "}
            (OpenAPI 3.1).
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>Connect an agent (MCP)</SectionTitle>
        <div className="glass-card rounded-xl p-6 space-y-3 text-sm text-muted-foreground">
          <p>
            Agents such as Hermes, Claude Code or Claude Desktop can use the
            same operations as MCP tools at{" "}
            <code className="font-mono text-foreground break-all">
              {mcpUrl}
            </code>{" "}
            (Streamable HTTP, stateless). It takes the same key in the same
            header, so the scopes, rate limit and request log are the
            API&apos;s, and revoking the key closes both. Each key sees only the
            tools its scopes allow; tool calls show as MCP in the request log.
          </p>
          <p>
            Create the key for the agent itself (as the owner, pick it under
            &quot;Key for&quot;), so its work is recorded under its own name.
            Agents should call{" "}
            <code className="font-mono text-foreground">finance_guide</code>{" "}
            first. Refusals they can fix come back as{" "}
            <code className="font-mono text-foreground">
              {"{ ok: false, error }"}
            </code>{" "}
            results; a bad key, the rate limit or an outage are errors.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-[rgba(var(--ink),0.06)] p-3 font-mono text-xs text-foreground">{`# Hermes: config.yaml (the key lives in the profile's .env as FINANCE_MCP_KEY)
mcp_servers:
  finance:
    url: "${mcpUrl}"
    headers: { x-api-key: "\${FINANCE_MCP_KEY}" }
    timeout: 55
    connect_timeout: 20
    trust: untrusted   # full once it runs unattended; books writes are drafts only
    tools: { resources: false, prompts: false }`}</pre>
          <p>
            Hermes asks before running any tool not marked read-only while trust
            is <code className="font-mono text-foreground">untrusted</code>. An
            agent on a schedule cannot answer, so switch it to{" "}
            <code className="font-mono text-foreground">full</code> once you
            trust it: every books write is still a draft for your review.
          </p>
          <details className="group">
            <summary className="cursor-pointer text-foreground rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring">
              All {MCP_TOOLS.length} tools
            </summary>
            <ul className="mt-2 divide-y divide-border/50">
              {MCP_TOOLS.map((tool) => (
                <li
                  key={tool.definition.name}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2"
                >
                  <code className="font-mono text-xs text-foreground">
                    {tool.definition.name}
                  </code>
                  <span className="text-xs">
                    {tool.scope ? `scope ${tool.scope}` : "every key"}
                    {tool.definition.annotations.readOnlyHint
                      ? " · read-only"
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>Scopes</SectionTitle>
        <ul className="glass-card rounded-xl divide-y divide-border/50">
          {API_SCOPES.map((scope) => (
            <li
              key={scope.key}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm"
            >
              <code className="font-mono text-foreground">{scope.key}</code>
              <span className="text-muted-foreground">{scope.description}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3">
        <SectionTitle>Errors</SectionTitle>
        <div className="glass-card rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Error statuses, codes and reasons
            </caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Code
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  details.reason
                </th>
              </tr>
            </thead>
            <tbody>
              {ERRORS.map(([status, code, reasons]) => (
                <tr key={status} className="border-t border-border/50">
                  <td className="px-4 py-2 text-foreground">{status}</td>
                  <td className="px-4 py-2 font-mono text-xs text-foreground">
                    {code}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                    {reasons}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {tags.map((tag) => (
        <div key={tag} className="space-y-3">
          <SectionTitle>{tag}</SectionTitle>
          {operations
            .filter((op) => op.tag === tag)
            .map((op) => {
              const parameters = parametersOf(op);
              return (
                <section
                  key={op.id}
                  aria-labelledby={`op-${op.id}`}
                  className="glass-card rounded-xl p-5 space-y-3"
                >
                  <div className="space-y-1">
                    <h3
                      id={`op-${op.id}`}
                      className="font-medium text-foreground"
                    >
                      {op.summary}
                    </h3>
                    <p className="flex flex-wrap items-center gap-2">
                      <Badge variant="info">{op.method}</Badge>
                      <code className="font-mono text-xs text-foreground break-all">
                        {op.path}
                      </code>
                    </p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    <Prose text={op.description} />
                  </p>
                  <p className="flex flex-wrap gap-2 text-xs">
                    <Badge>scope {op.permission}</Badge>
                    {toolFor(op) && <Badge>MCP {toolFor(op)}</Badge>}
                    <Badge
                      variant={op.source === "books" ? "success" : "copper"}
                    >
                      source {op.source}
                    </Badge>
                  </p>
                  {parameters.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <caption className="sr-only">
                          Parameters for {op.summary}
                        </caption>
                        <thead>
                          <tr className="text-left text-xs text-muted-foreground">
                            <th scope="col" className="py-1 pr-4 font-medium">
                              Parameter
                            </th>
                            <th scope="col" className="py-1 pr-4 font-medium">
                              Type
                            </th>
                            <th scope="col" className="py-1 font-medium">
                              About
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {parameters.map((p) => (
                            <tr
                              key={`${p.where}-${p.name}`}
                              className="border-t border-border/50 align-top"
                            >
                              <td className="py-1.5 pr-4 font-mono text-xs text-foreground whitespace-nowrap">
                                {p.name}
                                {p.required ? "" : "?"}
                                <span className="block font-sans text-[11px] text-muted-foreground">
                                  {p.where}
                                </span>
                              </td>
                              <td className="py-1.5 pr-4 font-mono text-xs text-muted-foreground">
                                {p.type}
                              </td>
                              <td className="py-1.5 text-xs text-muted-foreground">
                                <Prose text={p.description} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <pre className="overflow-x-auto rounded-lg bg-[rgba(var(--ink),0.06)] p-3 font-mono text-xs text-foreground">
                    {op.method === "GET"
                      ? `curl -H "x-api-key: $VM_API_KEY" "$ORIGIN${op.path.replace("{id}", "<id>")}"`
                      : `curl -X ${op.method} -H "x-api-key: $VM_API_KEY"${op.body ? ' -H "Content-Type: application/json"' : ""}${op.idempotent ? ' -H "Idempotency-Key: $(uuidgen)"' : ""}${op.body ? " -d '{...}'" : ""} "$ORIGIN${op.path.replace("{id}", "<id>")}"`}
                  </pre>
                </section>
              );
            })}
        </div>
      ))}
    </div>
  );
}
