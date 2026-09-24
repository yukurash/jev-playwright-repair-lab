import ts from "typescript";
import type { LocatorSpec } from "../../core/src/index.js";
import { locatorExpression } from "../../../fixtures/cases/index.js";

export class UnsupportedTestError extends Error {
  override name = "UnsupportedTestError";
}

export interface ActionSite {
  locator: LocatorSpec;
  operation: "click" | "fill";
  start: number;
  end: number;
  statementStart: number;
  statementEnd: number;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

function unsupported(message: string): never {
  throw new UnsupportedTestError(message);
}

function literal(node: ts.Node | undefined): string {
  if (!node || !ts.isStringLiteral(node)) return unsupported("Only static quoted string arguments are supported");
  return node.text;
}

function options(node: ts.Node | undefined, allowed: readonly string[]): Map<string, ts.Expression> {
  if (!node || !ts.isObjectLiteralExpression(node)) return unsupported("Exact static locator options are required");
  const result = new Map<string, ts.Expression>();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || !allowed.includes(property.name.text)) {
      return unsupported("Computed, spread, shorthand, and unknown locator options are unsupported");
    }
    if (result.has(property.name.text)) return unsupported("Duplicate locator options are unsupported");
    result.set(property.name.text, property.initializer);
  }
  if (result.get("exact")?.kind !== ts.SyntaxKind.TrueKeyword) return unsupported("Locators must specify exact: true");
  return result;
}

function parseScope(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node) && node.text === "page") return undefined;
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return unsupported("Only page and one named group scope are supported; helpers are unsupported");
  }
  const member = node.expression;
  if (!ts.isIdentifier(member.expression) || member.expression.text !== "page" || member.name.text !== "getByRole" || node.arguments.length !== 2) {
    return unsupported("Only one exact page.getByRole('group') scope is supported");
  }
  if (literal(node.arguments[0]) !== "group") return unsupported("Only named group scoping is supported");
  return literal(options(node.arguments[1], ["name", "exact"]).get("name"));
}

function parseLocator(node: ts.Expression): LocatorSpec {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return unsupported("Dynamic locators and custom helper calls are unsupported");
  }
  const method = node.expression.name.text;
  const scope = parseScope(node.expression.expression);
  if (node.arguments.length !== 2) return unsupported("Locator arguments must match the supported exact static shape");
  if (method === "getByRole") {
    const role = literal(node.arguments[0]);
    if (role !== "button" && role !== "textbox") return unsupported("Only button and textbox action roles are supported");
    return {
      kind: "role", role, name: literal(options(node.arguments[1], ["name", "exact"]).get("name")),
      ...(scope ? { scope } : {}),
    };
  }
  if (method === "getByLabel") {
    options(node.arguments[1], ["exact"]);
    return { kind: "label", label: literal(node.arguments[0]), ...(scope ? { scope } : {}) };
  }
  return unsupported("Locator chaining, .first(), filtering, and custom helpers are unsupported");
}

export function analyzeTest(source: string): ActionSite {
  const ast = ts.createSourceFile("original.spec.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["click", "fill"].includes(node.expression.name.text)) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (calls.length !== 1) return unsupported("Exactly one click/fill action is required");
  const call = calls[0];
  if (!call || !ts.isPropertyAccessExpression(call.expression)) return unsupported("No supported action");
  const operation = call.expression.name.text as "click" | "fill";
  if (operation === "click" && call.arguments.length !== 0) return unsupported("Click options, including force and custom timeouts, are unsupported");
  if (operation === "fill" && (call.arguments.length !== 1 || !ts.isStringLiteral(call.arguments[0]!))) {
    return unsupported("Fill requires one unchanged static string value and no options");
  }
  const receiver = call.expression.expression;
  const locator = parseLocator(receiver);
  let statement: ts.Node = call;
  while (statement.parent && !ts.isExpressionStatement(statement)) statement = statement.parent;
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression) || statement.expression.expression !== call) {
    return unsupported("The action must be a standalone awaited statement");
  }
  return {
    locator, operation, start: receiver.getStart(ast), end: receiver.getEnd(),
    statementStart: statement.getStart(ast), statementEnd: statement.getEnd(),
    startLine: ast.getLineAndCharacterOfPosition(statement.getStart(ast)).line + 1,
    endLine: ast.getLineAndCharacterOfPosition(statement.getEnd()).line + 1,
    startColumn: ast.getLineAndCharacterOfPosition(statement.getStart(ast)).character + 1,
    endColumn: ast.getLineAndCharacterOfPosition(statement.getEnd()).character + 1,
  };
}

export function patchLocator(source: string, site: ActionSite, replacement: LocatorSpec): string {
  const verified = analyzeTest(source);
  if (verified.start !== site.start || verified.end !== site.end
    || verified.operation !== site.operation || JSON.stringify(verified.locator) !== JSON.stringify(site.locator)) {
    throw new Error("AST locator range does not match the original test");
  }
  if (replacement.kind === "role"
    && ((site.operation === "click" && replacement.role !== "button") || (site.operation === "fill" && replacement.role !== "textbox"))) {
    throw new Error("Candidate role is incompatible with the preserved operation");
  }
  const replacementText = locatorExpression(replacement);
  const patched = source.slice(0, site.start) + replacementText + source.slice(site.end);
  const checked = analyzeTest(patched);
  if (checked.operation !== site.operation
    || patched.slice(0, checked.start) !== source.slice(0, site.start)
    || patched.slice(checked.end) !== source.slice(site.end)) {
    throw new Error("Patch changed content outside the verified locator range");
  }
  return patched;
}
