/** Scope-aware forbidden API detection for bundled sandbox code. */

import { SANDBOX_DISABLED_GLOBALS } from '@unzen/shared';
import ts from 'typescript';
import {
  createLexicalTypeChecker,
  isIdentifierReference,
  isUnboundGlobalReference,
} from './lexical-scope';

interface ForbiddenApiRule {
  name: string;
  description: string;
}

const SANDBOX_DISABLED_DESCRIPTIONS: Record<
  (typeof SANDBOX_DISABLED_GLOBALS)[number],
  string
> = {
  eval: 'eval() - dynamic code execution is blocked in sandbox',
  Function: 'new Function() - dynamic code execution is blocked in sandbox',
  Proxy: 'Proxy - object interception is disabled by sandbox hardening',
  Reflect: 'Reflect - reflective object access is disabled by sandbox hardening',
  WeakRef: 'WeakRef - garbage-collection observation is disabled by sandbox hardening',
  FinalizationRegistry:
    'FinalizationRegistry - garbage-collection observation is disabled by sandbox hardening',
  WebAssembly: 'WebAssembly - nested Wasm execution is disabled by sandbox hardening',
};

const FORBIDDEN_API_RULES: ForbiddenApiRule[] = [
  {
    name: 'fetch',
    description: 'fetch() - network requests are blocked in sandbox',
  },
  {
    name: 'XMLHttpRequest',
    description: 'XMLHttpRequest - network requests are blocked in sandbox',
  },
  {
    name: 'WebSocket',
    description: 'WebSocket - network connections are blocked in sandbox',
  },
  {
    name: 'importScripts',
    description: 'importScripts - dynamic script loading is blocked in sandbox',
  },
  ...SANDBOX_DISABLED_GLOBALS.map((name) => ({
    name,
    description: SANDBOX_DISABLED_DESCRIPTIONS[name],
  })),
  {
    name: 'require',
    description: 'require() - dynamic module loading is blocked in sandbox',
  },
];

const DYNAMIC_IMPORT_DESCRIPTION =
  'dynamic import() - dynamic module loading is blocked in sandbox';
const FORBIDDEN_API_NAMES = new Set(FORBIDDEN_API_RULES.map(rule => rule.name));
const GLOBAL_OBJECT_NAMES = new Set(['globalThis', 'self', 'window']);

function staticPropertyName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function staticNamedPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (
    ts.isComputedPropertyName(name)
    && ts.isStringLiteralLike(name.expression)
  ) {
    return name.expression.text;
  }
  return undefined;
}

function staticBindingPropertyName(element: ts.BindingElement): string | undefined {
  const property = element.propertyName ?? (
    ts.isIdentifier(element.name) ? element.name : undefined
  );
  return property ? staticNamedPropertyName(property) : undefined;
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/**
 * Check bundled JavaScript for sandbox-forbidden global APIs.
 *
 * TypeScript's binder distinguishes real global reads from local bindings, so
 * comments, strings, property keys, and intentionally shadowed names are not
 * violations. Static access through browser global objects is checked as well.
 * Each API is reported at most once.
 */
export function checkForbiddenApis(code: string): string[] {
  const sourceFile = ts.createSourceFile(
    '__unzen_bundle__.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const checker = createLexicalTypeChecker(sourceFile);
  const foundApis = new Set<string>();
  let foundDynamicImport = false;

  const isUnboundGlobalObject = (expression: ts.Expression): boolean => {
    const target = unwrapParentheses(expression);
    return ts.isIdentifier(target)
      && GLOBAL_OBJECT_NAMES.has(target.text)
      && isUnboundGlobalReference(target, checker);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      foundDynamicImport = true;
    }

    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
      && node.initializer
      && ts.isObjectBindingPattern(node.name)
      && isUnboundGlobalObject(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const name = staticBindingPropertyName(element);
        if (name && FORBIDDEN_API_NAMES.has(name)) foundApis.add(name);
      }
    }

    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && isUnboundGlobalObject(node.right)
    ) {
      const target = unwrapParentheses(node.left);
      if (ts.isObjectLiteralExpression(target)) {
        for (const property of target.properties) {
          const name = ts.isShorthandPropertyAssignment(property)
            ? property.name.text
            : ts.isPropertyAssignment(property)
              ? staticNamedPropertyName(property.name)
              : undefined;
          if (name && FORBIDDEN_API_NAMES.has(name)) foundApis.add(name);
        }
      }
    }

    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && isUnboundGlobalObject(node.expression)
    ) {
      const name = staticPropertyName(node);
      if (name && FORBIDDEN_API_NAMES.has(name)) foundApis.add(name);
    }

    if (
      ts.isIdentifier(node)
      && FORBIDDEN_API_NAMES.has(node.text)
      && isIdentifierReference(node)
      && isUnboundGlobalReference(node, checker)
    ) {
      foundApis.add(node.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const violations = FORBIDDEN_API_RULES
    .filter(rule => foundApis.has(rule.name))
    .map(rule => rule.description);
  if (foundDynamicImport) violations.push(DYNAMIC_IMPORT_DESCRIPTION);
  return violations;
}
