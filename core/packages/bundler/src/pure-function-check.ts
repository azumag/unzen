/** Scope-aware purity checks for functions extracted into an isolated runtime. */

import ts from 'typescript';
import {
  createLexicalTypeChecker,
  isIdentifierReference,
  isWithin,
  symbolForReference,
} from './lexical-scope';

type ExtractableFunction = ts.ArrowFunction | ts.FunctionExpression;

export interface UnzenPurityViolation {
  node: ts.Node;
  message: string;
}

export interface UnzenPurityAnalyzer {
  check(functionNode: ExtractableFunction): UnzenPurityViolation[];
}

export interface UnzenPurityAnalyzerOptions {
  /** Reuse an existing binding pass when another analyzer needs the same symbols. */
  checker?: ts.TypeChecker;
  /** Permit selected read-only references declared outside the extracted function. */
  allowExternalReference?: (node: ts.Identifier, symbol: ts.Symbol) => boolean;
}

const PURE_GLOBALS = new Set([
  'Array',
  'ArrayBuffer',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'Float32Array',
  'Float64Array',
  'Infinity',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Proxy',
  'RangeError',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
  'WeakMap',
  'WeakSet',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'undefined',
]);

const FORBIDDEN_GLOBALS = new Set([
  'Atomics',
  'BroadcastChannel',
  'Buffer',
  'Bun',
  'Deno',
  'EventSource',
  'Function',
  'MessageChannel',
  'MessagePort',
  'SharedArrayBuffer',
  'SharedWorker',
  'WebAssembly',
  'WebSocket',
  'Worker',
  'XMLHttpRequest',
  'caches',
  'console',
  'crypto',
  'document',
  'eval',
  'exports',
  'fetch',
  'global',
  'globalThis',
  'importScripts',
  'indexedDB',
  'localStorage',
  'location',
  'module',
  'navigator',
  'performance',
  'postMessage',
  'process',
  'queueMicrotask',
  'requestAnimationFrame',
  'require',
  'self',
  'sessionStorage',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'window',
]);

function isLocalReference(
  node: ts.Identifier,
  functionNode: ExtractableFunction,
  checker: ts.TypeChecker,
): boolean {
  return symbolForReference(node, checker)?.declarations?.some(
    (declaration) => isWithin(declaration, functionNode),
  ) ?? false;
}

function parameterForDeclaration(
  declaration: ts.Declaration,
  functionNode: ExtractableFunction,
): ts.ParameterDeclaration | undefined {
  let current: ts.Node | undefined = declaration;
  while (current && isWithin(current, functionNode)) {
    if (ts.isParameter(current)) return current;
    if (current === functionNode) break;
    current = current.parent;
  }
  return undefined;
}

function parameterForReference(
  node: ts.Identifier,
  functionNode: ExtractableFunction,
  checker: ts.TypeChecker,
): ts.ParameterDeclaration | undefined {
  const declarations = symbolForReference(node, checker)?.declarations;
  if (!declarations) return undefined;
  for (const declaration of declarations) {
    const parameter = parameterForDeclaration(declaration, functionNode);
    if (parameter) return parameter;
  }
  return undefined;
}

function hasArgumentsBinding(node: ts.Identifier, functionNode: ExtractableFunction): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && isWithin(current, functionNode)) {
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) return true;
    if (current === functionNode) break;
    current = current.parent;
  }
  return false;
}

function hasLocalThisBinding(node: ts.Node, functionNode: ExtractableFunction): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== functionNode) {
    if (ts.isArrowFunction(current)) {
      current = current.parent;
      continue;
    }
    if (
      ts.isMethodDeclaration(current)
      || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current)
      || ts.isConstructorDeclaration(current)
      || ts.isClassStaticBlockDeclaration(current)
    ) {
      return true;
    }
    if (ts.isFunctionExpression(current) || ts.isFunctionDeclaration(current)) return false;
    if (
      ts.isPropertyDeclaration(current)
      && (ts.isClassDeclaration(current.parent) || ts.isClassExpression(current.parent))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isUnshadowedGlobal(
  node: ts.Identifier,
  expectedName: string,
  functionNode: ExtractableFunction,
  checker: ts.TypeChecker,
): boolean {
  return node.text === expectedName
    && symbolForReference(node, checker) === undefined
    && !isLocalReference(node, functionNode, checker);
}

function staticProperty(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): { name: string; node: ts.Node } | undefined {
  if (ts.isPropertyAccessExpression(node)) return { name: node.name.text, node: node.name };
  if (node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
    return { name: node.argumentExpression.text, node: node.argumentExpression };
  }
  return undefined;
}

function staticBindingProperty(
  element: ts.BindingElement,
): { name: string; node: ts.Node } | undefined {
  const property = element.propertyName ?? (
    ts.isIdentifier(element.name) ? element.name : undefined
  );
  if (!property) return undefined;
  if (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) {
    return { name: property.text, node: property };
  }
  if (
    ts.isComputedPropertyName(property)
    && ts.isStringLiteralLike(property.expression)
  ) {
    return { name: property.expression.text, node: property.expression };
  }
  return undefined;
}

function unwrapMutationTarget(expression: ts.Expression): ts.Expression {
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

function mutationRoots(target: ts.Expression): ts.Identifier[] {
  const expression = unwrapMutationTarget(target);
  if (ts.isIdentifier(expression)) return [expression];
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return mutationRoots(expression.expression);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) => (
      ts.isOmittedExpression(element) ? [] : mutationRoots(element)
    ));
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return [property.name];
      if (ts.isPropertyAssignment(property)) return mutationRoots(property.initializer);
      if (ts.isSpreadAssignment(property)) return mutationRoots(property.expression);
      return [];
    });
  }
  if (ts.isSpreadElement(expression)) return mutationRoots(expression.expression);
  return [];
}

function mutationTargets(node: ts.Node): ts.Expression[] {
  if (
    ts.isBinaryExpression(node)
    && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return [node.left];
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && (node.operator === ts.SyntaxKind.PlusPlusToken
      || node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return [node.operand];
  }
  if (ts.isDeleteExpression(node)) return [node.expression];
  if (
    (ts.isForInStatement(node) || ts.isForOfStatement(node))
    && !ts.isVariableDeclarationList(node.initializer)
  ) {
    return [node.initializer];
  }
  return [];
}

/**
 * Create one analyzer per transformed module so all extracted functions share
 * a single TypeScript binding pass. The checker proves only directly visible
 * syntax; the isolated QuickJS runtime remains the security boundary for
 * aliases or dynamically computed property access that static analysis cannot
 * soundly resolve.
 */
export function createUnzenPurityAnalyzer(
  sourceFile: ts.SourceFile,
  options: UnzenPurityAnalyzerOptions = {},
): UnzenPurityAnalyzer {
  const checker = options.checker ?? createLexicalTypeChecker(sourceFile);

  return {
    check(functionNode) {
      const violations: UnzenPurityViolation[] = [];
      const coveredNodes = new Set<ts.Node>();

      const add = (node: ts.Node, message: string): void => {
        if (coveredNodes.has(node)) return;
        coveredNodes.add(node);
        violations.push({ node, message });
      };

      const visit = (node: ts.Node): void => {
        // Type annotations are erased before execution. Treating their names as
        // value reads would incorrectly reject imported interfaces and aliases.
        // `ExpressionWithTypeArguments` is shared by erased `implements` and
        // runtime `extends` clauses. isPartOfTypeNode() distinguishes those
        // contexts, whereas isTypeNode() alone would incorrectly skip Base in
        // `class Derived extends Base` and let a broken capture through.
        if (ts.isPartOfTypeNode(node)) return;

        if (
          ts.isCallExpression(node)
          && node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          add(node.expression, 'dynamic import is forbidden in Unzen pure functions');
        }
        if (ts.isMetaProperty(node)) {
          if (node.keywordToken === ts.SyntaxKind.ImportKeyword) {
            add(node, 'module context "import.meta" is unavailable after extraction');
          }
        }

        // Local mutation is useful for loops and working buffers, but writes
        // rooted at an input or intrinsic global violate the extraction's
        // input-only contract. This mirrors no-param-reassign with `props` and
        // no-global-assign while deliberately avoiding whole-program alias
        // analysis that would make a build transform unpredictable.
        for (const target of mutationTargets(node)) {
          for (const root of mutationRoots(target)) {
            const parameter = parameterForReference(root, functionNode, checker);
            if (parameter) {
              add(root, `assignment to input parameter ${JSON.stringify(root.text)} is forbidden`);
            } else if (root.text === 'arguments' && hasArgumentsBinding(root, functionNode)) {
              add(root, 'assignment to input binding "arguments" is forbidden');
            } else if (isLocalReference(root, functionNode, checker)) {
              // Locally owned state cannot escape unless explicitly returned.
            } else {
              const symbol = symbolForReference(root, checker);
              if ((symbol?.declarations?.length ?? 0) > 0) {
                add(
                  root,
                  `assignment to closure reference ${JSON.stringify(root.text)} is forbidden`,
                );
              } else if (PURE_GLOBALS.has(root.text)) {
                add(
                  root,
                  `assignment to standard global ${JSON.stringify(root.text)} is forbidden`,
                );
              } else if (FORBIDDEN_GLOBALS.has(root.text)) {
                add(
                  root,
                  `assignment to forbidden global ${JSON.stringify(root.text)} is forbidden`,
                );
              } else {
                add(
                  root,
                  `assignment to undeclared binding ${JSON.stringify(root.text)} is forbidden`,
                );
              }
            }
          }
        }

        if (
          (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
          && node.initializer
          && ts.isObjectBindingPattern(node.name)
        ) {
          const initializer = unwrapMutationTarget(node.initializer);
          if (ts.isIdentifier(initializer)) {
            let globalName: 'Math' | 'Date' | undefined;
            if (isUnshadowedGlobal(initializer, 'Math', functionNode, checker)) {
              globalName = 'Math';
            } else if (isUnshadowedGlobal(initializer, 'Date', functionNode, checker)) {
              globalName = 'Date';
            }
            if (globalName) {
              const forbiddenProperty = globalName === 'Math' ? 'random' : 'now';
              for (const element of node.name.elements) {
                const property = staticBindingProperty(element);
                if (property?.name === forbiddenProperty) {
                  add(
                    property.node,
                    `nondeterministic API "${globalName}.${forbiddenProperty}" is forbidden`,
                  );
                }
              }
            }
          }
        }

        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          const property = staticProperty(node);
          const receiver = node.expression;
          if (
            property?.name === 'random'
            && ts.isIdentifier(receiver)
            && isUnshadowedGlobal(receiver, 'Math', functionNode, checker)
          ) {
            add(property.node, 'nondeterministic API "Math.random" is forbidden');
          }
          if (
            property?.name === 'now'
            && ts.isIdentifier(receiver)
            && isUnshadowedGlobal(receiver, 'Date', functionNode, checker)
          ) {
            add(property.node, 'nondeterministic API "Date.now" is forbidden');
          }
        }

        if (
          ts.isNewExpression(node)
          && ts.isIdentifier(node.expression)
          && isUnshadowedGlobal(node.expression, 'Date', functionNode, checker)
          && (node.arguments?.length ?? 0) === 0
        ) {
          add(node.expression, 'nondeterministic API "new Date()" is forbidden');
        }
        if (
          ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && isUnshadowedGlobal(node.expression, 'Date', functionNode, checker)
        ) {
          add(node.expression, 'nondeterministic API "Date()" is forbidden');
        }

        if (node.kind === ts.SyntaxKind.ThisKeyword && !hasLocalThisBinding(node, functionNode)) {
          add(node, 'function context "this" is unavailable after extraction');
        }
        if (node.kind === ts.SyntaxKind.SuperKeyword && !hasLocalThisBinding(node, functionNode)) {
          add(node, 'function context "super" is unavailable after extraction');
        }

        if (ts.isIdentifier(node) && isIdentifierReference(node)) {
          const symbol = symbolForReference(node, checker);
          if (isLocalReference(node, functionNode, checker)) {
            // A local binding may intentionally shadow a restricted global.
          } else if (node.text === 'arguments' && hasArgumentsBinding(node, functionNode)) {
            // Regular functions receive their own arguments object; arrows do not.
          } else if (symbol && options.allowExternalReference?.(node, symbol)) {
            // Build-time dependency bundling may explicitly provide imported
            // values. Mutation remains forbidden by the assignment checks above.
          } else if ((symbol?.declarations?.length ?? 0) > 0) {
            add(
              node,
              `closure reference ${JSON.stringify(node.text)} is unavailable after extraction`,
            );
          } else if (FORBIDDEN_GLOBALS.has(node.text)) {
            add(
              node,
              `forbidden global ${JSON.stringify(node.text)} is not available ` +
                'in Unzen pure functions',
            );
          } else if (!PURE_GLOBALS.has(node.text)) {
            add(
              node,
              `closure reference ${JSON.stringify(node.text)} is unavailable after extraction`,
            );
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(functionNode);
      return violations.sort(
        (left, right) => left.node.getStart(sourceFile) - right.node.getStart(sourceFile),
      );
    },
  };
}
