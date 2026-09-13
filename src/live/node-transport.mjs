// THE ONLY PLACE IN THIS REPO THAT REACHES THE NETWORK.
//
// Both live transports take their HTTP implementation as a required argument and have no default.
// This file is the one thing that supplies a real one, and src/cli.mjs is the one thing that
// imports this file. That is not a convention, it is the mechanism: a test cannot open a socket
// by forgetting to inject a fake, because forgetting to inject one throws a TypeError.
//
// `test/no-network.test.mjs` asserts statically that nothing under test/ imports this module. A
// test that genuinely wants a socket has to edit that gate to get one, which is the point — the
// keyless, offline promise is kept by a file somebody has to change on purpose rather than by
// everybody remembering.
//
// Node's built-in fetch, nothing else. No SDK, no package, no dependency. `dependencies` and
// `devDependencies` are both empty and test/repo-hygiene.test.mjs keeps them that way.

export function nodeTransport() {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error(
      'this Node build has no global fetch, which live mode needs. Node 20 or newer is required; ' +
        'see the engines field in package.json',
    );
  }
  // Bound, not passed by reference, because an unbound fetch loses its receiver on some hosts.
  return (url, options) => globalThis.fetch(url, options);
}
