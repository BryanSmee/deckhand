// SANDBOX_SUBNETS' arithmetic: ranges, overlaps and the blocks left free.
import assert from "node:assert/strict";
import { test } from "node:test";
import { freeBlocks, overlaps, parseCidr } from "../listener/subnets.mjs";

const take = (gen, n) => Array.from({ length: n }, () => gen.next().value);
const range = (cidr, size) => ({ ...parseCidr(cidr), size });

test("parseCidr: IPv4 ranges with their host bits at zero", () => {
  assert.deepEqual(parseCidr("10.200.0.0/16"), { base: 0x0ac80000, prefix: 16 });
  assert.deepEqual(parseCidr("255.255.255.255/32"), { base: 0xffffffff, prefix: 32 });
  for (const bad of ["10.200.0.1/16", "10.200.0.0", "256.0.0.0/8", "10.0.0.0/33", "fd00::/8", ""]) {
    assert.equal(parseCidr(bad), null, bad);
  }
});

test("overlaps: any shared address; IPv6 never", () => {
  assert.ok(overlaps("10.0.0.0/8", "10.200.0.16/28"));
  assert.ok(overlaps("10.200.0.16/28", "10.0.0.0/8"));
  assert.ok(!overlaps("10.200.0.0/28", "10.200.0.16/28"));
  assert.ok(!overlaps("fd00::/64", "10.0.0.0/8"));
});

test("freeBlocks: lowest first, past whatever is in the way", () => {
  assert.deepEqual(take(freeBlocks(range("10.200.0.0/16", 28)), 3), [
    "10.200.0.0/28",
    "10.200.0.16/28",
    "10.200.0.32/28",
  ]);
  // A /24 in the middle, a /30 inside a block, an unrelated and an IPv6 network.
  const used = ["10.200.0.16/28", "10.200.1.0/24", "10.200.0.36/30", "172.17.0.0/16", "fd00::/64"];
  const blocks = [...freeBlocks(range("10.200.0.0/22", 28), used)];
  assert.equal(blocks[0], "10.200.0.0/28");
  assert.equal(blocks[1], "10.200.0.48/28");
  assert.ok(!blocks.some((b) => used.some((u) => overlaps(u, b))));
  assert.equal(blocks.length, 64 - 2 - 16);
  // A network covering the whole range: none.
  assert.deepEqual([...freeBlocks(range("10.200.0.0/24", 28), ["10.0.0.0/8"])], []);
  // Lazy: a /8 of /29s isn't listed whole to find the first.
  assert.equal(freeBlocks(range("10.0.0.0/8", 29)).next().value, "10.0.0.0/29");
});
