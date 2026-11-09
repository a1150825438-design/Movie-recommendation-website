const crypto = require("crypto");

const lines = [];

function test(name, fn) {
  try { fn(); lines.push("  PASS  " + name);}
  catch (e) { lines.push("  FAIL  " + name + "  ->  " + e.message);}
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || "Fail") + "：Expected " + b + ", Actual " + a);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || "Fail"); }
function truthy(v, msg) { if (!v) throw new Error(msg || "Fail"); }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}


test("Correct password passed", () => {
  const { salt, hash } = hashPassword("secret123");
  truthy(verifyPassword("secret123", salt, hash), "Correct password should be passed");
});
test("Incorrect password failed", () => {
  const { salt, hash } = hashPassword("secret123");
  ok(verifyPassword("wrongpass", salt, hash) === false, "Incorrect password should be failed");
});
test("Same text hashed twice produces different salts and hashes", () => {
  const a = hashPassword("same"), b = hashPassword("same");
  ok(a.salt !== b.salt, "Salt should be random");
  ok(a.hash !== b.hash, "Hash should be different");
});

console.log(lines.join("\n"));
