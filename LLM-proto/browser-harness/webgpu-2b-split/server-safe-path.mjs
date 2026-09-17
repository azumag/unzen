import * as nodePath from 'node:path';

export function safePathWithPathApi(pathApi, root, relativePath) {
  const value = pathApi.resolve(root, `.${pathApi.normalize(`/${relativePath}`)}`);
  const fromRoot = pathApi.relative(root, value);
  if (
    fromRoot === '..'
    || fromRoot.startsWith(`..${pathApi.sep}`)
    || pathApi.isAbsolute(fromRoot)
  ) {
    throw new Error('path escapes root');
  }
  return value;
}

export function safePath(root, relativePath) {
  return safePathWithPathApi(nodePath, root, relativePath);
}
