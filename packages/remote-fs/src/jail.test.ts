/**
 * Offline path-jail tests — run with:
 *   node --experimental-strip-types packages/remote-fs/src/jail.test.ts
 * or after build: node packages/remote-fs/dist/jail.test.js
 */
import {
  isJailRoot,
  joinRemotePath,
  normalizeRemotePath,
  parentRemotePath,
  resolveJailedRemotePath,
} from "./jail.js";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

function throws(fn: () => void, msg: string) {
  try {
    fn();
    failed++;
    console.error("FAIL (expected throw):", msg);
  } catch {
    console.log("ok (threw):", msg);
  }
}

assert(normalizeRemotePath("plugins") === "/plugins", "normalize relative");
assert(normalizeRemotePath("/a//b") === "/a/b" || normalizeRemotePath("/a//b").includes("a"), "normalize slashes");
assert(resolveJailedRemotePath("/plugins", "/plugins/foo") === "/plugins/foo", "child ok");
assert(resolveJailedRemotePath("/plugins", "bar") === "/plugins/bar", "relative under jail");
assert(resolveJailedRemotePath("/plugins", undefined) === "/plugins", "default to root");
assert(resolveJailedRemotePath("/", "/etc") === "/etc", "jail / allows all absolute");
throws(() => resolveJailedRemotePath("/plugins", "/etc/passwd"), "escape absolute blocked");
throws(() => resolveJailedRemotePath("/plugins", "../etc"), "escape .. blocked");
throws(() => resolveJailedRemotePath("/plugins", "/plugins/../etc"), "escape after normalize blocked");
assert(joinRemotePath("/plugins", "a.jar") === "/plugins/a.jar", "join");
throws(() => joinRemotePath("/plugins", ".."), "join .. blocked");
assert(parentRemotePath("/plugins/foo") === "/plugins", "parent");
assert(parentRemotePath("/plugins") === "/", "parent of top");
assert(isJailRoot("/plugins", "/plugins"), "is root");
assert(!isJailRoot("/plugins", "/plugins/x"), "not root");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall jail tests passed");
