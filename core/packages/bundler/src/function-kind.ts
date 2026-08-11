import ts from 'typescript';

/** Whether a syntax node is a function-like declaration marked async. */
export function isAsyncFunctionLike(node: ts.Node): boolean {
  if (!ts.isFunctionLike(node) || !ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
  ) ?? false;
}

/** Whether a syntax node is a generator function-like declaration. */
export function isGeneratorFunctionLike(node: ts.Node): boolean {
  if (!ts.isFunctionLike(node)) return false;
  return (node as ts.FunctionLikeDeclaration & {
    asteriskToken?: ts.AsteriskToken;
  }).asteriskToken !== undefined;
}
