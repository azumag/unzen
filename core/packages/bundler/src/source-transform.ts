/** Compile-time extraction of inline Unzen function definitions. */

import MagicString, { type SourceMap } from 'magic-string';
import { dirname } from 'node:path';
import ts from 'typescript';
import { bundle } from './bundler';
import {
  createLexicalTypeChecker,
  isIdentifierReference,
  symbolForReference,
} from './lexical-scope';
import { createUnzenPurityAnalyzer } from './pure-function-check';

const UNZEN_SERVER_MODULE = '@unzen/server';
const SAFE_FUNCTION_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/;
const TYPE_PRINTER = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

type ExtractableFunction = ts.ArrowFunction | ts.FunctionExpression;

export interface ExtractedUnzenDefinition {
  name: string;
  /** Source module used for duplicate diagnostics during declaration generation. */
  fileName: string;
  /** One-based source line containing the transformed define call. */
  line: number;
  /** One-based source column containing the transformed define call. */
  column: number;
  /** Generic parameters, without the surrounding angle brackets. */
  typeParameters: string[];
  /** Runtime parameters represented as portable declaration fragments. */
  parameters: ExtractedUnzenParameter[];
  /** Explicit return annotation, or unknown when the source relies on inference. */
  returnType: string;
}

export interface ExtractedUnzenParameter {
  name: string;
  type: string;
  optional: boolean;
  rest: boolean;
}

export interface UnzenSourceTransformResult {
  code: string;
  map: SourceMap;
  definitions: ExtractedUnzenDefinition[];
}

/** Explicit opt-in for bundling runtime imports referenced by inline functions. */
export interface UnzenDependencyBundlingOptions {
  /** Package patterns permitted inside extracted functions and their dependencies. */
  allowedModules: string[];
  /** Project directory used to resolve packages; defaults to the source file directory. */
  resolveDir?: string;
  /** Maximum UTF-8 byte size per bundled function; defaults to 100 KiB. */
  maxBundleSize?: number;
}

interface UnzenDefinitionPlan {
  call: ts.CallExpression;
  receiver: ts.PropertyAccessExpression;
  functionNode: ExtractableFunction;
  name: string;
  optionsText: string;
  definition: ExtractedUnzenDefinition;
}

interface UnzenSourceAnalysis {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  plans: UnzenDefinitionPlan[];
}

interface RuntimeImportBinding {
  declaration: ts.ImportDeclaration;
  localName: string;
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

function isAsyncFunction(node: ExtractableFunction): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

/**
 * Capture only syntax that remains meaningful in a standalone declaration.
 * Default initializers are runtime expressions, so they become optional
 * parameters. Missing annotations deliberately become unknown instead of
 * guessing a potentially unsound public contract from an isolated module.
 */
function extractSignature(
  sourceFile: ts.SourceFile,
  node: ExtractableFunction,
): Pick<ExtractedUnzenDefinition, 'typeParameters' | 'parameters' | 'returnType'> {
  const typeParameters = node.typeParameters?.map((parameter) => (
    parameter.getText(sourceFile)
  )) ?? [];
  const parameters = node.parameters.map((parameter, index): ExtractedUnzenParameter => {
    const rest = parameter.dotDotDotToken !== undefined;
    const defaultBeforeRequired = parameter.initializer !== undefined
      && node.parameters.slice(index + 1).some((following) => (
        following.questionToken === undefined
        && following.initializer === undefined
        && following.dotDotDotToken === undefined
      ));
    let type = parameter.type?.getText(sourceFile) ?? (rest ? 'unknown[]' : 'unknown');
    if (defaultBeforeRequired && parameter.type) {
      // `x = default, required` cannot become `x?` in a declaration because a
      // required parameter may not follow an optional one. TypeScript models
      // this call boundary as required-but-undefined-able instead.
      type = TYPE_PRINTER.printNode(
        ts.EmitHint.Unspecified,
        ts.factory.createUnionTypeNode([
          parameter.type,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
        ]),
        sourceFile,
      );
    }
    return {
      // Binding patterns are useful inside the implementation but not at the
      // call boundary. A stable positional name keeps the generated signature
      // valid without copying destructuring syntax or default expressions.
      name: ts.isIdentifier(parameter.name) ? parameter.name.text : `arg${index + 1}`,
      type,
      optional: parameter.questionToken !== undefined
        || (parameter.initializer !== undefined && !defaultBeforeRequired),
      rest,
    };
  });
  return {
    typeParameters,
    parameters,
    returnType: node.type?.getText(sourceFile) ?? 'unknown',
  };
}

/**
 * Transpile one isolated function expression, then read its initializer back
 * from the JavaScript AST. This removes TypeScript-only syntax without brittle
 * string slicing or compiling the surrounding application module.
 */
function transpileFunction(
  sourceFile: ts.SourceFile,
  node: ExtractableFunction,
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

function enclosingImportDeclaration(node: ts.Node): ts.ImportDeclaration | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isImportDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function runtimeImportBindingForSymbol(symbol: ts.Symbol): RuntimeImportBinding | undefined {
  for (const declaration of symbol.declarations ?? []) {
    const importDeclaration = enclosingImportDeclaration(declaration);
    const importClause = importDeclaration?.importClause;
    if (!importDeclaration || !importClause || importClause.isTypeOnly) continue;

    if (
      ts.isImportSpecifier(declaration)
      && !declaration.isTypeOnly
    ) {
      return { declaration: importDeclaration, localName: declaration.name.text };
    }
    if (ts.isNamespaceImport(declaration)) {
      return { declaration: importDeclaration, localName: declaration.name.text };
    }
    if (ts.isImportClause(declaration) && declaration.name) {
      return { declaration: importDeclaration, localName: declaration.name.text };
    }
  }
  return undefined;
}

function collectRuntimeImports(
  functionNode: ExtractableFunction,
  checker: ts.TypeChecker,
): Map<ts.ImportDeclaration, Set<string>> {
  const imports = new Map<ts.ImportDeclaration, Set<string>>();

  const visit = (node: ts.Node): void => {
    if (ts.isPartOfTypeNode(node)) return;
    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      const symbol = symbolForReference(node, checker);
      const binding = symbol && runtimeImportBindingForSymbol(symbol);
      if (binding) {
        const names = imports.get(binding.declaration) ?? new Set<string>();
        names.add(binding.localName);
        imports.set(binding.declaration, names);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(functionNode);
  return imports;
}

function filterRuntimeImport(
  declaration: ts.ImportDeclaration,
  localNames: Set<string>,
): ts.ImportDeclaration | undefined {
  const clause = declaration.importClause;
  if (!clause || clause.isTypeOnly) return undefined;

  const defaultImport = clause.name && localNames.has(clause.name.text)
    ? clause.name
    : undefined;
  let namedBindings: ts.NamedImportBindings | undefined;
  if (
    clause.namedBindings
    && ts.isNamespaceImport(clause.namedBindings)
    && localNames.has(clause.namedBindings.name.text)
  ) {
    namedBindings = clause.namedBindings;
  } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    const elements = clause.namedBindings.elements.filter(
      (element) => !element.isTypeOnly && localNames.has(element.name.text),
    );
    if (elements.length > 0) {
      namedBindings = ts.factory.updateNamedImports(clause.namedBindings, elements);
    }
  }

  if (!defaultImport && !namedBindings) return undefined;
  const importClause = ts.factory.updateImportClause(
    clause,
    clause.phaseModifier,
    defaultImport,
    namedBindings,
  );
  return ts.factory.updateImportDeclaration(
    declaration,
    declaration.modifiers,
    importClause,
    declaration.moduleSpecifier,
    declaration.attributes,
  );
}

function renderRuntimeImports(
  functionNode: ExtractableFunction,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): string[] {
  const imports = collectRuntimeImports(functionNode, checker);
  const rendered: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const localNames = imports.get(statement);
    if (!localNames) continue;
    const declaration = statement;
    const filtered = filterRuntimeImport(declaration, localNames);
    if (filtered) {
      rendered.push(TYPE_PRINTER.printNode(ts.EmitHint.Unspecified, filtered, sourceFile));
    }
  }
  return rendered;
}

function analyzeUnzenSource(
  source: string,
  fileName: string,
  allowRuntimeImports: boolean,
): UnzenSourceAnalysis | null {
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

  const checker = createLexicalTypeChecker(sourceFile);
  const purityAnalyzer = createUnzenPurityAnalyzer(sourceFile, {
    checker,
    allowExternalReference: allowRuntimeImports
      ? (_node, symbol) => runtimeImportBindingForSymbol(symbol) !== undefined
      : undefined,
  });
  const plans: UnzenDefinitionPlan[] = [];

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

    const purityViolation = purityAnalyzer.check(functionNode)[0];
    if (purityViolation) {
      fail(sourceFile, purityViolation.node, purityViolation.message);
    }

    const { line, column } = locationOf(sourceFile, call);
    plans.push({
      call,
      receiver: call.expression as ts.PropertyAccessExpression,
      functionNode,
      name,
      optionsText: call.arguments[2]
        ? `, ${call.arguments[2]!.getText(sourceFile)}`
        : '',
      definition: {
        name,
        fileName: sourceFile.fileName,
        line,
        column,
        ...extractSignature(sourceFile, functionNode),
      },
    });
  }

  return plans.length > 0 ? { sourceFile, checker, plans } : null;
}

function renderTransformResult(
  source: string,
  fileName: string,
  analysis: UnzenSourceAnalysis,
  functionCodes: string[],
): UnzenSourceTransformResult {
  const output = new MagicString(source);
  for (const [index, plan] of analysis.plans.entries()) {
    const replacement = `${plan.receiver.expression.getText(analysis.sourceFile)}.defineRaw(`
      + `${JSON.stringify(plan.name)}, ${JSON.stringify(functionCodes[index]!)}${plan.optionsText})`;
    output.overwrite(plan.call.getStart(analysis.sourceFile), plan.call.end, replacement);
  }

  return {
    code: output.toString(),
    map: output.generateMap({
      source: fileName,
      file: fileName,
      includeContent: true,
      hires: true,
    }),
    definitions: analysis.plans.map((plan) => plan.definition),
  };
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
  const analysis = analyzeUnzenSource(source, fileName, false);
  if (!analysis) return null;
  return renderTransformResult(
    source,
    fileName,
    analysis,
    analysis.plans.map((plan) => transpileFunction(analysis.sourceFile, plan.functionNode)),
  );
}

/**
 * Rewrite inline definitions while bundling only the runtime imports each
 * extracted function actually reads. Enabling this mode is explicit because
 * dependency resolution and esbuild make the transform asynchronous.
 */
export async function transformUnzenDefinitionsWithDependencies(
  source: string,
  fileName: string,
  options: UnzenDependencyBundlingOptions,
): Promise<UnzenSourceTransformResult | null> {
  const analysis = analyzeUnzenSource(source, fileName, true);
  if (!analysis) return null;
  const allowedModules = [...options.allowedModules];
  const resolveDir = options.resolveDir ?? dirname(fileName);

  const functionCodes: string[] = [];
  for (const plan of analysis.plans) {
    const functionCode = transpileFunction(analysis.sourceFile, plan.functionNode);
    const imports = renderRuntimeImports(
      plan.functionNode,
      analysis.checker,
      analysis.sourceFile,
    );
    if (imports.length === 0) {
      functionCodes.push(functionCode);
      continue;
    }

    try {
      const result = await bundle({
        code: `${imports.join('\n')}\nexport const run = ${functionCode};`,
        allowedModules,
        resolveDir,
        maxBundleSize: options.maxBundleSize,
      });
      functionCodes.push(result.code);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(
        analysis.sourceFile,
        plan.call,
        `cannot bundle dependencies for ${JSON.stringify(plan.name)}: ${message}`,
      );
    }
  }

  return renderTransformResult(source, fileName, analysis, functionCodes);
}
