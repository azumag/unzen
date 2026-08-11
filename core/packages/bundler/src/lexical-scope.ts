import ts from 'typescript';

/**
 * Bind one source file without resolving its imports or loading the standard
 * library. This gives build-time analyzers TypeScript's lexical scope rules
 * while keeping each transform local and deterministic.
 */
export function createLexicalTypeChecker(sourceFile: ts.SourceFile): ts.TypeChecker {
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const canonicalFileName = (fileName: string): string => (
    ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()
  );
  const rootName = canonicalFileName(sourceFile.fileName);

  const host: ts.CompilerHost = {
    fileExists: (fileName) => canonicalFileName(fileName) === rootName,
    getCanonicalFileName: canonicalFileName,
    getCurrentDirectory: () => '',
    getDefaultLibFileName: () => 'lib.d.ts',
    getDirectories: () => [],
    getNewLine: () => '\n',
    getSourceFile: (fileName) => (
      canonicalFileName(fileName) === rootName ? sourceFile : undefined
    ),
    readFile: (fileName) => (
      canonicalFileName(fileName) === rootName ? sourceFile.text : undefined
    ),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    writeFile: () => undefined,
  };
  const program = ts.createProgram({
    rootNames: [sourceFile.fileName],
    options: compilerOptions,
    host,
  });
  return program.getTypeChecker();
}

export function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

export function symbolForReference(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (ts.isShorthandPropertyAssignment(node.parent)) {
    // getSymbolAtLocation() returns the synthesized object-property symbol for
    // `{ value }`, not the lexical `value` read.
    return checker.getShorthandAssignmentValueSymbol(node.parent);
  }
  return checker.getSymbolAtLocation(node);
}

export function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;

  // Most declaration/property nodes expose their syntactic key as `name`.
  // Those identifiers do not read a runtime binding. Shorthand properties are
  // deliberately excluded because `{ value }` both names a key and reads value.
  if (
    !ts.isShorthandPropertyAssignment(parent)
    && 'name' in parent
    && (parent as ts.NamedDeclaration).name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if (ts.isBreakOrContinueStatement(parent) && parent.label === node) return false;
  return true;
}

export function isUnboundGlobalReference(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): boolean {
  return (symbolForReference(node, checker)?.declarations?.length ?? 0) === 0;
}
