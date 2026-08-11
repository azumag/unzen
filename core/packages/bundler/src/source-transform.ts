/** Compile-time extraction of inline Unzen function definitions. */

import MagicString, { type SourceMap } from 'magic-string';
import ts from 'typescript';

const UNZEN_SERVER_MODULE = '@unzen/server';
const SAFE_FUNCTION_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/;

export interface ExtractedUnzenDefinition {
  name: string;
  /** One-based source line containing the transformed define call. */
  line: number;
  /** One-based source column containing the transformed define call. */
  column: number;
}

export interface UnzenSourceTransformResult {
  code: string;
  map: SourceMap;
  definitions: ExtractedUnzenDefinition[];
}

/** Build error with a stable file/line/column location for adapter diagnostics. */
export class UnzenTransformError extends Error {
  constructor(
    message: string,
    readonly fileName: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`[unzen] ${fileName}:${line}:${column} ${message}`);
    this.name = 'UnzenTransformError';
  }
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  const path = fileName.toLowerCase();
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function locationOf(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { line: number; column: number } {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: location.line + 1, column: location.character + 1 };
}

function fail(sourceFile: ts.SourceFile, node: ts.Node, message: string): never {
  const { line, column } = locationOf(sourceFile, node);
  throw new UnzenTransformError(message, sourceFile.fileName, line, column);
}

function collectUnzenImports(sourceFile: ts.SourceFile): {
  constructors: Set<string>;
  namespaces: Set<string>;
} {
  const constructors = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== UNZEN_SERVER_MODULE
      || statement.importClause?.isTypeOnly
    ) {
      continue;
    }

    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === 'UnzenServer') {
          constructors.add(element.name.text);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }

  return { constructors, namespaces };
}

function isUnzenConstructor(
  expression: ts.Expression,
  constructors: Set<string>,
  namespaces: Set<string>,
): boolean {
  if (ts.isIdentifier(expression)) return constructors.has(expression.text);
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && namespaces.has(expression.expression.text)
    && expression.name.text === 'UnzenServer';
}

function collectServerInstances(
  sourceFile: ts.SourceFile,
  constructors: Set<string>,
  namespaces: Set<string>,
): Set<string> {
  const instances = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement)
      || (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.initializer
        && ts.isNewExpression(declaration.initializer)
        && isUnzenConstructor(declaration.initializer.expression, constructors, namespaces)
      ) {
        instances.add(declaration.name.text);
      }
    }
  }

  return instances;
}

function unwrapFunctionExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isAsyncFunction(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

/**
 * Transpile one isolated function expression, then read its initializer back
 * from the JavaScript AST. This removes TypeScript-only syntax without brittle
 * string slicing or compiling the surrounding application module.
 */
function transpileFunction(
  sourceFile: ts.SourceFile,
  node: ts.ArrowFunction | ts.FunctionExpression,
): string {
  const wrappedSource = `const __unzen_function__ = ${node.getText(sourceFile)};`;
  const transpiled = ts.transpileModule(wrappedSource, {
    fileName: sourceFile.fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2018,
      module: ts.ModuleKind.ESNext,
      removeComments: false,
    },
  });
  const diagnostic = transpiled.diagnostics?.find(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  );
  if (diagnostic) {
    fail(
      sourceFile,
      node,
      `cannot extract function: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    );
  }

  const javascript = ts.createSourceFile(
    '__unzen_function__.js',
    transpiled.outputText,
    ts.ScriptTarget.ES2018,
    true,
    ts.ScriptKind.JS,
  );
  let functionStatement: ts.VariableStatement | undefined;
  let functionInitializer: ts.Expression | undefined;
  for (const statement of javascript.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.name.text === '__unzen_function__'
        && declaration.initializer
      ) {
        functionStatement = statement;
        functionInitializer = declaration.initializer;
      }
    }
  }
  if (!functionStatement || !functionInitializer) {
    fail(sourceFile, node, 'could not read the transpiled function expression');
  }

  // Downleveling constructs such as private class fields can emit helpers
  // beside the temporary declaration. Keep those helpers in an IIFE so the
  // extracted function never references support code that was discarded.
  if (
    javascript.statements.length !== 1
    || functionStatement.declarationList.declarations.length !== 1
  ) {
    return `(() => {\n${transpiled.outputText}\nreturn __unzen_function__;\n})()`;
  }
  return functionInitializer.getText(javascript);
}

function isKnownDefineCall(call: ts.CallExpression, serverInstances: Set<string>): boolean {
  return ts.isPropertyAccessExpression(call.expression)
    && call.expression.name.text === 'define'
    && ts.isIdentifier(call.expression.expression)
    && serverInstances.has(call.expression.expression.text);
}

/**
 * Rewrite supported top-level `UnzenServer#define` calls to `defineRaw`.
 *
 * Only a const initialized directly from an imported UnzenServer constructor
 * is eligible. This explicit binding check prevents unrelated `.define()` APIs
 * from being rewritten. Returning null lets build tools skip unchanged files.
 */
export function transformUnzenDefinitions(
  source: string,
  fileName: string,
): UnzenSourceTransformResult | null {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );
  const { constructors, namespaces } = collectUnzenImports(sourceFile);
  if (constructors.size === 0 && namespaces.size === 0) return null;

  const serverInstances = collectServerInstances(sourceFile, constructors, namespaces);
  if (serverInstances.size === 0) return null;

  const output = new MagicString(source);
  const definitions: ExtractedUnzenDefinition[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
      continue;
    }
    const call = statement.expression;
    if (!isKnownDefineCall(call, serverInstances)) continue;
    if (call.arguments.length < 2 || call.arguments.length > 3) {
      fail(sourceFile, call, 'define() requires a name, an inline function, and optional options');
    }

    const nameNode = call.arguments[0]!;
    if (!ts.isStringLiteral(nameNode) && !ts.isNoSubstitutionTemplateLiteral(nameNode)) {
      fail(sourceFile, call, 'define() name must be a static string literal');
    }
    const name = nameNode.text;
    if (!SAFE_FUNCTION_NAME.test(name)) {
      fail(sourceFile, call, `invalid Unzen function name ${JSON.stringify(name)}`);
    }

    const functionNode = unwrapFunctionExpression(call.arguments[1]!);
    if (!ts.isArrowFunction(functionNode) && !ts.isFunctionExpression(functionNode)) {
      fail(sourceFile, call, 'define() requires an inline arrow or function expression');
    }
    if (isAsyncFunction(functionNode) || functionNode.asteriskToken !== undefined) {
      fail(sourceFile, call, 'Unzen build extraction supports synchronous functions only');
    }

    const receiver = call.expression as ts.PropertyAccessExpression;
    const functionCode = transpileFunction(sourceFile, functionNode);
    const options = call.arguments[2]
      ? `, ${call.arguments[2]!.getText(sourceFile)}`
      : '';
    const replacement = `${receiver.expression.getText(sourceFile)}.defineRaw(`
      + `${JSON.stringify(name)}, ${JSON.stringify(functionCode)}${options})`;
    output.overwrite(call.getStart(sourceFile), call.end, replacement);

    const { line, column } = locationOf(sourceFile, call);
    definitions.push({ name, line, column });
  }

  if (definitions.length === 0) return null;
  return {
    code: output.toString(),
    map: output.generateMap({
      source: fileName,
      file: fileName,
      includeContent: true,
      hires: true,
    }),
    definitions,
  };
}
